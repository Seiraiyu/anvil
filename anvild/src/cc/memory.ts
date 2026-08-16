/**
 * Auto-memory browsing (cc-config design §6.4). CC keys memory by git repository — all worktrees and
 * subdirectories of a repo share one directory — and reports the resolved path on every turn as
 * `init.memory_paths.auto`. Anvil READS that path and never derives it (principle 1).
 *
 * `MEMORY.md` is the index and the only file loaded at session start (first 200 lines or 25KB,
 * whichever comes first). Topic files are read on demand by the agent. CC accepts a write that blows
 * the budget and then drops the overflow on the next load, so `memoryBudget` exists to warn BEFORE
 * saving — an over-budget save is silent data loss.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export const MEMORY_INDEX = "MEMORY.md";
export const MEMORY_LINE_LIMIT = 200;
export const MEMORY_BYTE_LIMIT = 25 * 1024;
/** Warn when within this fraction of a limit. */
const NEAR = 0.9;

export interface MemoryFile {
  name: string;
  bytes: number;
  modified: string; // ISO
}

export interface MemoryBudget {
  lines: number;
  bytes: number;
  state: "ok" | "near" | "over";
}

/**
 * Resolve `name` inside `dir`, refusing anything that escapes it. Mirrors the worktree-escape check
 * in agent/pipeline-guard.ts: compare against `dir + "/"` so a sibling sharing the prefix cannot slip
 * through, and resolve symlinks so a link out of the directory is caught too.
 */
export function resolveInside(dir: string, name: string): string {
  const root = realpathSync(resolve(dir));
  const abs = resolve(root, name);
  const real = existsSync(abs) ? realpathSync(abs) : abs;
  if (real !== root && !real.startsWith(`${root}/`)) {
    throw new Error(`refusing ${name}: outside the memory directory`);
  }
  return real;
}

/** List markdown files, MEMORY.md first then the rest alphabetically. Missing dir ⇒ empty. */
export function listMemory(dir: string): MemoryFile[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, bytes: st.size, modified: st.mtime.toISOString() };
    });
  return files.sort((a, b) =>
    a.name === MEMORY_INDEX ? -1 : b.name === MEMORY_INDEX ? 1 : a.name.localeCompare(b.name),
  );
}

export function readMemoryFile(dir: string, name: string): { text: string; modified: string } {
  const abs = resolveInside(dir, name);
  const st = statSync(abs);
  return { text: readFileSync(abs, "utf8"), modified: st.mtime.toISOString() };
}

/**
 * Measure what CC will actually load. YAML frontmatter and block-level HTML comments are stripped
 * before the index is loaded, so they must not count — counting them would warn on files that fit.
 */
export function memoryBudget(text: string): MemoryBudget {
  const noFm = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  // A block comment occupying whole lines must take its terminating newline with it. Stripping only
  // the `<!-- … -->` span leaves the newline behind as a phantom blank line, which inflates the count
  // and warns on files that actually fit — the exact failure this function exists to prevent.
  // The second pass then clears any inline comment without disturbing surrounding line breaks.
  const noComments = noFm.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n?/gm, "").replace(/<!--[\s\S]*?-->/g, "");
  const lines = noComments.split("\n").filter((l, i, a) => i < a.length - 1 || l.length > 0).length;
  const bytes = Buffer.byteLength(noComments, "utf8");
  const over = lines > MEMORY_LINE_LIMIT || bytes > MEMORY_BYTE_LIMIT;
  const near = lines >= MEMORY_LINE_LIMIT * NEAR || bytes >= MEMORY_BYTE_LIMIT * NEAR;
  return { lines, bytes, state: over ? "over" : near ? "near" : "ok" };
}

/**
 * Write a memory file.
 *
 * `expectedModified` is the mtime the caller last read. If the file changed since, the write is
 * REJECTED — Claude writes to this directory during a live session, and a UI edit must not clobber a
 * concurrent agent write. Omit it only when creating a new file.
 */
export function writeMemoryFile(dir: string, name: string, text: string, expectedModified?: string): { modified: string } {
  if (!name.endsWith(".md")) throw new Error(`refusing ${name}: only .md files live in memory`);
  const abs = resolveInside(dir, name);
  if (existsSync(abs) && expectedModified) {
    const cur = statSync(abs).mtime.toISOString();
    if (cur !== expectedModified) {
      throw new Error(`refusing write: ${name} changed on disk since it was read`);
    }
  }
  writeFileSync(abs, text, "utf8");
  return { modified: statSync(abs).mtime.toISOString() };
}

export function deleteMemoryFile(dir: string, name: string): void {
  const abs = resolveInside(dir, name);
  unlinkSync(abs);
}

// ── memory settings (task 13) ───────────────────────────────────────────────────────────────────

export interface MemorySettings {
  autoMemoryEnabled: boolean;
  /** Where CC stores auto memory. Anvil SURFACES this and never sets it on its own (design §6.4,
   *  principle 2): relocating memory into a repo creates an untracked directory the user must then
   *  commit or ignore, which is Anvil making a repo decision by side effect. */
  autoMemoryDirectory?: string;
}

const settingsPath = (home: string): string => join(home, ".claude", "settings.json");

function readSettings(home: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(home), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readMemorySettings(home: string = homedir()): MemorySettings {
  const s = readSettings(home);
  return {
    autoMemoryEnabled: s.autoMemoryEnabled !== false, // on by default
    autoMemoryDirectory: typeof s.autoMemoryDirectory === "string" ? s.autoMemoryDirectory : undefined,
  };
}

/** Patch memory settings, preserving everything else. `autoMemoryDirectory: null` clears the key. */
export function writeMemorySettings(
  patch: { autoMemoryEnabled?: boolean; autoMemoryDirectory?: string | null },
  home: string = homedir(),
): void {
  if (typeof patch.autoMemoryDirectory === "string") {
    const v = patch.autoMemoryDirectory;
    if (!v.startsWith("/") && !v.startsWith("~/")) {
      throw new Error("autoMemoryDirectory must be absolute or start with ~/");
    }
  }
  const next = { ...readSettings(home) };
  if (patch.autoMemoryEnabled !== undefined) next.autoMemoryEnabled = patch.autoMemoryEnabled;
  if (patch.autoMemoryDirectory === null) delete next.autoMemoryDirectory;
  else if (patch.autoMemoryDirectory !== undefined) next.autoMemoryDirectory = patch.autoMemoryDirectory;

  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(home), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}
