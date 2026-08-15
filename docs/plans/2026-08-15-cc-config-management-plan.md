# Claude Code Config Management — Implementation Plan

**Goal:** Manage the whole per-machine `~/.claude` surface — plugins, MCP servers, auto-mode config, and memory — from Anvil's UI on every box in the fleet, with a diff-based sync for the declarative domains and no terminal anywhere.
**Architecture:** Thin adapters shell out to Claude Code's non-interactive subcommands (`claude plugin … --json`, `claude mcp …`, `claude auto-mode …`) and to the filesystem for memory; one P7-style domain service (`CcConfigService`) owns all four domains; REST lands in the existing `/api/cc/v1` route table behind a new `cc-config` capability; the web client gets a Settings → Claude Code area with four sections and a per-item sync diff.
**Tech Stack:** Bun/TypeScript, `bun:test`, vanilla-TS web client, jsdom for DOM tests.

**Design:** [`2026-08-15-claude-code-config-management-design.md`](2026-08-15-claude-code-config-management-design.md) (approved, commit `4a1fa89`).

**GATES:** none. cc-cli-transport plans 1–9 are merged to `main`; upstream is synced through PR #199.

## Status

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Plugin list fixtures | pending | no | no |
| 2 | `src/cc/plugins.ts` types + `parsePluginList` | pending | no | no |
| 3 | Plugin read commands | pending | no | no |
| 4 | Plugin write commands | pending | no | no |
| 5 | Marketplace commands | pending | no | no |
| 6 | Tolerant `claude mcp list` parser | pending | no | no |
| 7 | MCP commands | pending | no | no |
| 8 | Auto-mode fixtures | pending | no | no |
| 9 | `src/cc/automode.ts` read + `$defaults` splice | pending | no | no |
| 10 | Auto-mode write + critique + reset | pending | no | no |
| 11 | `src/cc/memory.ts` list/read + path confinement + budget | pending | no | no |
| 12 | Memory write/delete + stale-write rejection | pending | no | no |
| 13 | Memory settings (`autoMemoryEnabled`, `autoMemoryDirectory`) | pending | no | no |
| 14 | `cc-config` capability + contract test | pending | no | no |
| 15 | `CcConfigService` + Deps guard test | pending | no | no |
| 16 | Wire the service into the server | pending | no | no |
| 17 | REST read routes (4 domains) | pending | no | no |
| 18 | REST write routes + job progress | pending | no | no |
| 19 | Protocol: `PermissionMode` gains `auto`/`dontAsk` + golden regen | pending | no | no |
| 20 | `auto` becomes the new-session default | pending | no | no |
| 21 | Sync diff computation (plugins, MCP, autoMode) | pending | no | no |
| 22 | Sync REST endpoint | pending | no | no |
| 23 | Web: `ccconfig.ts` seam + Settings section shell | pending | no | no |
| 24 | Web: plugin + MCP rendering and actions | pending | no | no |
| 25 | Web: auto-mode editor with `$defaults` guard | pending | no | no |
| 26 | Web: memory browser/editor | pending | no | no |
| 27 | Web: sync diff UI | pending | no | no |
| 28 | Web DOM tests | pending | no | no |
| 29 | Docs: ARCHITECTURE + SECURITY | pending | no | no |
| 30 | Live pass on hub + one member | pending | no | no |

---

## Ground rules for the executing engineer

Read these once; they apply to every task.

- **All commands run from `anvild/`** unless stated otherwise.
- **Never mutate the developer's real `~/.claude`.** Every automated test that invokes an adapter must
  point `HOME` at a temp dir, or inject a fake `CommandRunner`. **There is no exception.** This matters
  more here than it did for plugins alone: the memory tasks write to a memory directory, and the
  developer's real memory is irreplaceable.
- **Reuse, don't reinvent.** `CommandRunner` and `defaultRun` already exist in `src/cc/install.ts`;
  `resolveCcCommand(env)` resolves the CC binary. Import them. The exact signature is:
  ```ts
  export type CommandRunner = (
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ) => Promise<{ code: number; out: string }>;
  ```
  Note `out` is **merged stdout+stderr**, already trimmed.
- After each task: `bun run typecheck` must pass. After web tasks also `bun run typecheck:web` **and**
  `bun run build:web` (the daemon serves `web/dist`, not the source).
- Commit after each task with the message given.

### Carried tasks

Tasks marked **CARRIED** reuse the complete code in
[`2026-08-15-plugin-mcp-management-plan.md`](2026-08-15-plugin-mcp-management-plan.md), which is in this
repo. Open it, find the cited task, and follow it verbatim **after applying this rename table
globally**:

| In the superseded plan | Use instead |
|---|---|
| capability `"plugins"` | `"cc-config"` |
| `src/session/plugin-service.ts` | `src/session/ccconfig-service.ts` |
| `PluginService` / `PluginServiceDeps` | `CcConfigService` / `CcConfigServiceDeps` |
| `test/unit/plugin-service-deps.test.ts` | `test/unit/ccconfig-service-deps.test.ts` |
| `web/src/plugins.ts` / `initPlugins` | `web/src/ccconfig.ts` / `initCcConfig` |
| "Settings → Plugins" tab | "Settings → Claude Code" section |

REST paths under `/api/cc/v1/` are unchanged.

---

## Task 1: Plugin list fixtures — **CARRIED**

Follow superseded plan **Task 1** verbatim. Creates `test/fixtures/cc/plugin-list.json` and
`plugin-list-empty.json`.

`git commit -m "test(cc-config): golden claude plugin list --json fixtures"`

## Task 2: `src/cc/plugins.ts` types + `parsePluginList` — **CARRIED**

Follow superseded plan **Task 2** verbatim.

`git commit -m "feat(cc-config): plugin list types + strict-but-tolerant parser"`

## Task 3: Plugin read commands — **CARRIED**

Follow superseded plan **Task 3** verbatim (`listPlugins`, `listAvailable`).

`git commit -m "feat(cc-config): plugin read commands"`

## Task 4: Plugin write commands — **CARRIED**

Follow superseded plan **Task 4** verbatim (install/uninstall/enable/disable/update).

`git commit -m "feat(cc-config): plugin write commands"`

## Task 5: Marketplace commands — **CARRIED**

Follow superseded plan **Task 5** verbatim.

`git commit -m "feat(cc-config): marketplace commands"`

## Task 6: Tolerant `claude mcp list` parser — **CARRIED**

Follow superseded plan **Task 6** verbatim. Keep the degrade-to-raw behavior: it must never throw, and
must never render an unparsed list as empty (an empty list reads as "no servers", which is a lie).

`git commit -m "feat(cc-config): tolerant mcp list parser"`

## Task 7: MCP commands — **CARRIED**

Follow superseded plan **Task 7** verbatim (list/add/remove).

`git commit -m "feat(cc-config): mcp add/remove commands"`

---

## Task 8: Auto-mode fixtures

**Files:**
- Create: `anvild/test/fixtures/cc/automode-defaults.json`
- Create: `anvild/test/fixtures/cc/automode-config.json`

**Step 1: Capture from the real CLI**

```bash
claude auto-mode defaults > anvild/test/fixtures/cc/automode-defaults.json
claude auto-mode config   > anvild/test/fixtures/cc/automode-config.json
```

**Step 2: Trim**

Both files are large. Keep the four top-level keys (`allow`, `soft_deny`, `hard_deny`, `environment`)
but trim each array to its first 3 entries — the parser cares about shape, not volume. Do not
reformat the strings; they are prose and must stay verbatim so the test proves we pass them through
untouched.

**Step 3: Verify shape**

Run: `bun -e 'const d=require("./test/fixtures/cc/automode-defaults.json"); console.log(Object.keys(d).sort().join(","), Array.isArray(d.soft_deny))'`
Expected: `allow,environment,hard_deny,soft_deny true`

**Step 4: Commit**

`git commit -m "test(cc-config): claude auto-mode defaults/config fixtures"`

---

## Task 9: `src/cc/automode.ts` read + `$defaults` splice

**Files:**
- Create: `anvild/src/cc/automode.ts`
- Create: `anvild/test/unit/cc-automode.test.ts`

**Step 1: Write failing test**

`anvild/test/unit/cc-automode.test.ts`:

```ts
/**
 * The auto-mode adapter (cc-config design §6.5). `claude auto-mode config|defaults` are
 * non-interactive JSON, so reads are a straight parse. The `$defaults` splice is the dangerous part:
 * an array WITHOUT the literal "$defaults" silently discards CC's entire built-in list for that
 * section, so `splicedPreview` exists to show a user exactly what their edit would produce.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAutoModeConfig, splicedPreview, hasDefaultsSentinel, AUTOMODE_SECTIONS } from "../../src/cc/automode";

const fixture = (n: string): string => readFileSync(join(import.meta.dir, "../fixtures/cc", n), "utf8");

test("parses the real CLI's auto-mode config into the four sections", () => {
  const cfg = parseAutoModeConfig(fixture("automode-config.json"));
  for (const s of AUTOMODE_SECTIONS) expect(Array.isArray(cfg[s])).toBe(true);
  expect(cfg.soft_deny.length).toBeGreaterThan(0);
  expect(typeof cfg.soft_deny[0]).toBe("string"); // prose, passed through verbatim
});

test("a missing section parses as an empty array rather than undefined", () => {
  const cfg = parseAutoModeConfig(JSON.stringify({ allow: ["x"] }));
  expect(cfg.allow).toEqual(["x"]);
  expect(cfg.soft_deny).toEqual([]);
  expect(cfg.hard_deny).toEqual([]);
  expect(cfg.environment).toEqual([]);
});

test("garbage input throws rather than yielding a config that silently drops rules", () => {
  expect(() => parseAutoModeConfig("not json")).toThrow();
});

test("hasDefaultsSentinel detects the literal $defaults entry", () => {
  expect(hasDefaultsSentinel(["$defaults", "mine"])).toBe(true);
  expect(hasDefaultsSentinel(["mine"])).toBe(false);
  expect(hasDefaultsSentinel([])).toBe(false); // empty also discards the defaults
});

test("splicedPreview expands $defaults in place, preserving position", () => {
  const out = splicedPreview(["before", "$defaults", "after"], ["d1", "d2"]);
  expect(out).toEqual(["before", "d1", "d2", "after"]);
});

test("splicedPreview without the sentinel returns ONLY the user entries — the footgun", () => {
  const out = splicedPreview(["mine"], ["d1", "d2"]);
  expect(out).toEqual(["mine"]); // CC's built-ins are gone; the UI must warn on this
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-automode.test.ts`
Expected: FAIL with `Cannot find module '../../src/cc/automode'`

**Step 3: Implement**

`anvild/src/cc/automode.ts`:

```ts
/**
 * Auto-mode classifier configuration (cc-config design §6.5). Claude Code shipped `auto` as a
 * permission mode on 2026-08-14: a classifier blocks irreversible/destructive/exfiltrating actions.
 * The `autoMode` settings block tunes that classifier.
 *
 * Anvil reads the EFFECTIVE config through `claude auto-mode config` rather than reading
 * settings.json, because the effective value is the merge of user + managed + `--settings` scopes and
 * only the CLI knows that merge (design principle 1: never reimplement CC's logic).
 *
 * The `$defaults` sentinel is the sharp edge. Setting any section WITHOUT the literal "$defaults"
 * string replaces CC's entire built-in list for that section — silently. `splicedPreview` renders
 * what a given edit actually produces so the UI can show it, and `hasDefaultsSentinel` drives the
 * warning.
 */
import { resolveCcCommand, defaultRun, type CommandRunner } from "./install";

export const AUTOMODE_SECTIONS = ["allow", "soft_deny", "hard_deny", "environment"] as const;
export type AutoModeSection = (typeof AUTOMODE_SECTIONS)[number];

/** The four prose rule lists. Every entry is natural language, never a pattern — pass through verbatim. */
export type AutoModeConfig = Record<AutoModeSection, string[]>;

/** The literal string that splices CC's built-in rules into a user array at that position. */
export const DEFAULTS_SENTINEL = "$defaults";

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Parse `claude auto-mode config|defaults` output. Throws on non-JSON: a silently-empty config
 *  would render as "no rules", which would misrepresent the machine's actual safety posture. */
export function parseAutoModeConfig(raw: string): AutoModeConfig {
  const j = JSON.parse(raw) as Record<string, unknown>;
  if (!j || typeof j !== "object") throw new Error("auto-mode config is not an object");
  return {
    allow: strings(j.allow),
    soft_deny: strings(j.soft_deny),
    hard_deny: strings(j.hard_deny),
    environment: strings(j.environment),
  };
}

/** True when the array will INHERIT CC's built-ins. An empty array does not — it discards them. */
export function hasDefaultsSentinel(entries: string[]): boolean {
  return entries.includes(DEFAULTS_SENTINEL);
}

/** What `entries` actually resolves to, with `defaults` spliced in at the sentinel's position.
 *  Without the sentinel the defaults are dropped entirely — that is CC's behavior, reproduced here
 *  so the UI can show the user the loss before they save. */
export function splicedPreview(entries: string[], defaults: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e === DEFAULTS_SENTINEL) out.push(...defaults);
    else out.push(e);
  }
  return out;
}

async function ccAutoMode(
  args: string[],
  run: CommandRunner,
  env: Record<string, string | undefined>,
): Promise<string> {
  const cmd = resolveCcCommand(env);
  const r = await run([...cmd, "auto-mode", ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`claude auto-mode ${args.join(" ")} failed: ${r.out.slice(-800)}`);
  return r.out;
}

/** The effective config: the user's settings merged over CC's built-ins. */
export async function readAutoModeConfig(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<AutoModeConfig> {
  return parseAutoModeConfig(await ccAutoMode(["config"], run, env));
}

/** CC's built-in rules — what `$defaults` splices in. Needed to render `splicedPreview`. */
export async function readAutoModeDefaults(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<AutoModeConfig> {
  return parseAutoModeConfig(await ccAutoMode(["defaults"], run, env));
}
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-automode.test.ts`
Expected: PASS, 6 tests

**Step 5: Commit**

`git commit -m "feat(cc-config): auto-mode config reader + \$defaults splice preview"`

---

## Task 10: Auto-mode write + critique + reset

**Files:**
- Modify: `anvild/src/cc/automode.ts`
- Modify: `anvild/test/unit/cc-automode.test.ts`

**Step 1: Write failing test** (append)

```ts
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeAutoModeBlock } from "../../src/cc/automode";

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cc-automode-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

test("writeAutoModeBlock writes ONLY the autoMode key and preserves the rest of settings.json", () => {
  const home = fakeHome();
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ autoMemoryEnabled: true, permissions: { ask: ["Bash(git push *)"] } }, null, 2));

  writeAutoModeBlock({ allow: ["$defaults", "mine"], soft_deny: [], hard_deny: [], environment: ["$defaults"] }, home);

  const after = JSON.parse(readFileSync(settings, "utf8"));
  expect(after.autoMode.allow).toEqual(["$defaults", "mine"]);
  expect(after.autoMemoryEnabled).toBe(true);            // untouched
  expect(after.permissions.ask).toEqual(["Bash(git push *)"]); // untouched
});

test("writeAutoModeBlock creates settings.json when absent", () => {
  const home = fakeHome();
  writeAutoModeBlock({ allow: [], soft_deny: [], hard_deny: [], environment: [] }, home);
  const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  expect(after.autoMode).toBeDefined();
});

test("writeAutoModeBlock drops empty sections rather than writing [] — [] discards CC's defaults", () => {
  const home = fakeHome();
  writeAutoModeBlock({ allow: ["$defaults"], soft_deny: [], hard_deny: [], environment: [] }, home);
  const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  expect(after.autoMode.allow).toEqual(["$defaults"]);
  expect("soft_deny" in after.autoMode).toBe(false);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-automode.test.ts`
Expected: FAIL — `writeAutoModeBlock` is not exported

**Step 3: Implement** (append to `src/cc/automode.ts`)

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Write the `autoMode` block into the USER settings file, merging over whatever else is there.
 *
 * [SEC] Always `~/.claude/settings.json` — never a project settings file. CC deliberately excludes
 * `.claude/settings.json` and `.claude/settings.local.json` from autoMode resolution so a checked-in
 * repo cannot inject its own allow rules; writing there would reopen the hole CC closed
 * (design §9).
 *
 * Empty sections are OMITTED rather than written as `[]`, because `[]` is not "no opinion" — it
 * discards CC's entire built-in list for that section.
 */
export function writeAutoModeBlock(cfg: AutoModeConfig, home: string = homedir()): void {
  const dir = join(home, ".claude");
  const path = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    /* absent or unparseable — treat as empty and rewrite (CC would ignore an unparseable file too) */
  }

  const block: Record<string, string[]> = {};
  for (const s of AUTOMODE_SECTIONS) if (cfg[s].length) block[s] = cfg[s];

  writeFileSync(path, `${JSON.stringify({ ...current, autoMode: block }, null, 2)}\n`, { mode: 0o600 });
}

/** `claude auto-mode critique` — AI feedback on custom rules. Returns the CLI's prose verbatim. */
export async function critiqueAutoMode(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  return ccAutoMode(["critique"], run, env);
}

/** `claude auto-mode reset --yes` — removes the autoMode section from user settings. */
export async function resetAutoMode(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  await ccAutoMode(["reset", "--yes"], run, env);
}
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-automode.test.ts`
Expected: PASS, 9 tests

**Step 5: Commit**

`git commit -m "feat(cc-config): auto-mode block writer (user settings only), critique, reset"`

---

## Task 11: `src/cc/memory.ts` list/read + path confinement + budget

**Files:**
- Create: `anvild/src/cc/memory.ts`
- Create: `anvild/test/unit/cc-memory.test.ts`

**Step 1: Write failing test**

`anvild/test/unit/cc-memory.test.ts`:

```ts
/**
 * The memory adapter (cc-config design §6.4). Memory lives wherever CC says it lives — the directory
 * comes from `init.memory_paths.auto`, never derived here (principle 1; deriving the project slug
 * would reimplement CC logic and break silently when CC changes it).
 *
 * Two invariants are security-relevant: every file access is confined to the memory dir (no
 * traversal, no symlink escape), and MEMORY.md's 200-line / 25KB budget is reported, because CC
 * accepts an over-budget write and then drops the overflow on the next load — a silent save is data
 * loss in effect.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMemory, readMemoryFile, memoryBudget, MEMORY_LINE_LIMIT, MEMORY_BYTE_LIMIT } from "../../src/cc/memory";

function memDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cc-memory-"));
  const m = join(d, "memory");
  mkdirSync(m, { recursive: true });
  return m;
}

test("lists MEMORY.md first, then topic files, with sizes", () => {
  const m = memDir();
  writeFileSync(join(m, "debugging.md"), "# debug\n");
  writeFileSync(join(m, "MEMORY.md"), "- [a](a.md)\n");
  writeFileSync(join(m, "api.md"), "# api\n");
  const out = listMemory(m);
  expect(out[0]!.name).toBe("MEMORY.md"); // the index is the only file loaded every session
  expect(out.map((f) => f.name)).toEqual(["MEMORY.md", "api.md", "debugging.md"]);
  expect(out[0]!.bytes).toBeGreaterThan(0);
});

test("a missing memory dir lists empty rather than throwing", () => {
  expect(listMemory(join(tmpdir(), "definitely-not-here-xyz"))).toEqual([]);
});

test("non-markdown files are ignored", () => {
  const m = memDir();
  writeFileSync(join(m, "MEMORY.md"), "x\n");
  writeFileSync(join(m, "notes.txt"), "x\n");
  expect(listMemory(m).map((f) => f.name)).toEqual(["MEMORY.md"]);
});

test("readMemoryFile returns contents", () => {
  const m = memDir();
  writeFileSync(join(m, "MEMORY.md"), "hello\n");
  expect(readMemoryFile(m, "MEMORY.md").text).toBe("hello\n");
});

test("path traversal is rejected", () => {
  const m = memDir();
  expect(() => readMemoryFile(m, "../outside.md")).toThrow(/outside the memory directory/);
  expect(() => readMemoryFile(m, "/etc/passwd")).toThrow(/outside the memory directory/);
  expect(() => readMemoryFile(m, "sub/../../escape.md")).toThrow(/outside the memory directory/);
});

test("a symlink escaping the memory dir is rejected", () => {
  const m = memDir();
  writeFileSync(join(m, "..", "secret.md"), "s\n");
  symlinkSync(join(m, "..", "secret.md"), join(m, "link.md"));
  expect(() => readMemoryFile(m, "link.md")).toThrow(/outside the memory directory/);
});

test("memoryBudget reports ok / near / over against the 200-line and 25KB limits", () => {
  expect(memoryBudget("a\n".repeat(10)).state).toBe("ok");
  expect(memoryBudget("a\n".repeat(MEMORY_LINE_LIMIT - 5)).state).toBe("near");
  expect(memoryBudget("a\n".repeat(MEMORY_LINE_LIMIT + 1)).state).toBe("over");
  expect(memoryBudget("x".repeat(MEMORY_BYTE_LIMIT + 1)).state).toBe("over");
});

test("frontmatter and block HTML comments do not count toward the budget", () => {
  // CC strips both before loading, so counting them would warn on files that actually fit.
  const body = "a\n".repeat(20);
  const withFm = `---\nname: x\n---\n<!--\n${"c\n".repeat(500)}-->\n${body}`;
  expect(memoryBudget(withFm).lines).toBe(memoryBudget(body).lines);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: FAIL with `Cannot find module '../../src/cc/memory'`

**Step 3: Implement**

`anvild/src/cc/memory.ts`:

```ts
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
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

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
  const noComments = noFm.replace(/<!--[\s\S]*?-->/g, "");
  const lines = noComments.split("\n").filter((l, i, a) => i < a.length - 1 || l.length > 0).length;
  const bytes = Buffer.byteLength(noComments, "utf8");
  const over = lines > MEMORY_LINE_LIMIT || bytes > MEMORY_BYTE_LIMIT;
  const near = lines >= MEMORY_LINE_LIMIT * NEAR || bytes >= MEMORY_BYTE_LIMIT * NEAR;
  return { lines, bytes, state: over ? "over" : near ? "near" : "ok" };
}
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: PASS, 8 tests

**Step 5: Commit**

`git commit -m "feat(cc-config): memory listing, confined reads, MEMORY.md budget"`

---

## Task 12: Memory write/delete + stale-write rejection

**Files:**
- Modify: `anvild/src/cc/memory.ts`
- Modify: `anvild/test/unit/cc-memory.test.ts`

**Step 1: Write failing test** (append)

```ts
import { rmSync } from "node:fs";
import { writeMemoryFile, deleteMemoryFile } from "../../src/cc/memory";

test("writes a file and returns the new mtime", () => {
  const m = memDir();
  const r = writeMemoryFile(m, "notes.md", "hello\n");
  expect(readMemoryFile(m, "notes.md").text).toBe("hello\n");
  expect(typeof r.modified).toBe("string");
});

test("a write whose expectedModified is stale is REJECTED (Claude writes memory mid-session)", () => {
  const m = memDir();
  writeMemoryFile(m, "notes.md", "v1\n");
  const stale = "1999-01-01T00:00:00.000Z";
  expect(() => writeMemoryFile(m, "notes.md", "v2\n", stale)).toThrow(/changed on disk/);
  expect(readMemoryFile(m, "notes.md").text).toBe("v1\n"); // unchanged
});

test("a write with the CURRENT mtime succeeds", () => {
  const m = memDir();
  writeMemoryFile(m, "notes.md", "v1\n");
  const cur = readMemoryFile(m, "notes.md").modified;
  writeMemoryFile(m, "notes.md", "v2\n", cur);
  expect(readMemoryFile(m, "notes.md").text).toBe("v2\n");
});

test("creating a NEW file requires no expectedModified", () => {
  const m = memDir();
  writeMemoryFile(m, "fresh.md", "x\n", undefined);
  expect(readMemoryFile(m, "fresh.md").text).toBe("x\n");
});

test("writes and deletes are confined to the memory dir", () => {
  const m = memDir();
  expect(() => writeMemoryFile(m, "../escape.md", "x")).toThrow(/outside the memory directory/);
  expect(() => deleteMemoryFile(m, "../escape.md")).toThrow(/outside the memory directory/);
});

test("delete removes the file", () => {
  const m = memDir();
  writeMemoryFile(m, "gone.md", "x\n");
  deleteMemoryFile(m, "gone.md");
  expect(listMemory(m).map((f) => f.name)).not.toContain("gone.md");
});

test("only .md files may be written", () => {
  const m = memDir();
  expect(() => writeMemoryFile(m, "evil.sh", "#!/bin/sh")).toThrow(/only \.md/);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: FAIL — `writeMemoryFile` is not exported

**Step 3: Implement** (append to `src/cc/memory.ts`)

```ts
import { writeFileSync, unlinkSync } from "node:fs";

/**
 * Write a memory file.
 *
 * `expectedModified` is the mtime the caller last read. If the file changed since, the write is
 * REJECTED — Claude writes to this directory during a live session, and a UI edit must not clobber a
 * concurrent agent write. Omit it only when creating a new file.
 */
export function writeMemoryFile(
  dir: string,
  name: string,
  text: string,
  expectedModified?: string,
): { modified: string } {
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
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: PASS, 15 tests

**Step 5: Commit**

`git commit -m "feat(cc-config): memory writes with stale-write rejection + delete"`

---

## Task 13: Memory settings

**Files:**
- Modify: `anvild/src/cc/memory.ts`
- Modify: `anvild/test/unit/cc-memory.test.ts`

**Step 1: Write failing test** (append)

```ts
import { readMemorySettings, writeMemorySettings } from "../../src/cc/memory";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "cc-mem-home-"));
  mkdirSync(join(h, ".claude"), { recursive: true });
  return h;
}

test("defaults: auto memory enabled, no custom directory", () => {
  expect(readMemorySettings(home())).toEqual({ autoMemoryEnabled: true, autoMemoryDirectory: undefined });
});

test("reads both keys", () => {
  const h = home();
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ autoMemoryEnabled: false, autoMemoryDirectory: "~/mem" }));
  expect(readMemorySettings(h)).toEqual({ autoMemoryEnabled: false, autoMemoryDirectory: "~/mem" });
});

test("writing the toggle preserves other settings", () => {
  const h = home();
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ autoMode: { allow: ["$defaults"] } }));
  writeMemorySettings({ autoMemoryEnabled: false }, h);
  const after = JSON.parse(readFileSync(join(h, ".claude", "settings.json"), "utf8"));
  expect(after.autoMemoryEnabled).toBe(false);
  expect(after.autoMode.allow).toEqual(["$defaults"]); // untouched
});

test("autoMemoryDirectory must be absolute or ~/-prefixed, as CC requires", () => {
  const h = home();
  expect(() => writeMemorySettings({ autoMemoryDirectory: "relative/path" }, h)).toThrow(/absolute or start with/);
  writeMemorySettings({ autoMemoryDirectory: "~/mem" }, h);
  writeMemorySettings({ autoMemoryDirectory: "/srv/mem" }, h);
});

test("clearing autoMemoryDirectory removes the key rather than writing empty string", () => {
  const h = home();
  writeMemorySettings({ autoMemoryDirectory: "~/mem" }, h);
  writeMemorySettings({ autoMemoryDirectory: null }, h);
  const after = JSON.parse(readFileSync(join(h, ".claude", "settings.json"), "utf8"));
  expect("autoMemoryDirectory" in after).toBe(false);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: FAIL — `readMemorySettings` is not exported

**Step 3: Implement** (append to `src/cc/memory.ts`)

```ts
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

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
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: PASS, 20 tests

**Step 5: Commit**

`git commit -m "feat(cc-config): memory settings read/write (directory surfaced, never set)"`

---

## Task 14: `cc-config` capability + contract test — **CARRIED**

Follow superseded plan **Task 8**, with the capability string `"cc-config"` and this comment:

```ts
  // One Anvil surface for the per-machine ~/.claude config: plugins, MCP servers, auto-mode config,
  // and memory (cc-config design). Clients gate the whole Settings → Claude Code area on this, so an
  // older daemon renders nothing rather than dead controls.
  "cc-config",
```

`git commit -m "feat(cc-config): cc-config capability"`

## Task 15: `CcConfigService` + Deps guard test — **CARRIED (extended)**

Follow superseded plan **Task 9**, renamed per the table. Extend `CcConfigServiceDeps` with the two
new domains:

```ts
export interface CcConfigServiceDeps {
  /* …plugin + mcp deps from the superseded plan… */

  /** The CC binary vector + env, so every adapter call inherits account selection. */
  ccEnv: () => Record<string, string | undefined>;
  /** The memory directory CC reported on the last turn (`init.memory_paths.auto`). Undefined until a
   *  turn has run — the UI shows "run a turn to locate memory" rather than guessing a path. */
  memoryDir: () => string | undefined;
}
```

`memoryDir` is the seam that keeps principle 1: the service never derives a project slug.

`git commit -m "feat(cc-config): CcConfigService domain service + deps guard"`

## Task 16: Wire the service into the server — **CARRIED**

Follow superseded plan **Task 10**, renamed.

Additionally: capture `memory_paths.auto` from the `init` line. In `src/cc/turn-runner.ts`, where
`init` is already parsed, store `memory_paths?.auto` on the session and expose it through the
supervisor so `memoryDir()` can read it. Add a unit test asserting a parsed `init` with
`memory_paths` populates it.

`git commit -m "feat(cc-config): wire service + capture memory_paths.auto from init"`

## Task 17: REST read routes — **CARRIED (extended)**

Follow superseded plan **Task 11**, then add:

| Method | Path | Handler |
|---|---|---|
| GET | `/api/cc/v1/automode` | `{ config, defaults }` from Task 9 |
| GET | `/api/cc/v1/memory` | `{ dir, files, indexBudget }` from Task 11 |
| GET | `/api/cc/v1/memory/settings` | Task 13 |

Register in the `route`/`routeRe` table in `src/server/http.ts` — do not add an `if` ladder. Use
`routeRe` for the per-file path with an encoded filename segment.

`git commit -m "feat(cc-config): REST read routes for all four domains"`

## Task 18: REST write routes + job progress — **CARRIED (extended)**

Follow superseded plan **Task 12**, then add `PUT /api/cc/v1/automode`, `POST
/api/cc/v1/automode/critique`, `PUT|DELETE /api/cc/v1/memory/:file`, `PUT
/api/cc/v1/memory/settings`.

A stale-write rejection (Task 12) must surface as **HTTP 409**, not 500 — the web client
distinguishes them to offer a reload-and-merge instead of an error toast.

`git commit -m "feat(cc-config): REST write routes + job progress"`

---

## Task 19: Protocol — `PermissionMode` gains `auto` and `dontAsk`

**Files:**
- Modify: `docs/plans/anvil-protocol.ts` (the real file; `anvild/protocol.ts` is a symlink)
- Modify: `anvild/test/contract/protocol-surface.golden.json` (regenerated)

**Step 1: Edit the union**

In `docs/plans/anvil-protocol.ts`, replace the `PermissionMode` type and its constant:

```ts
export type PermissionMode =
  | "default" // Manual: CC's standard engine — safe tools auto-allowed, everything else prompts
  | "acceptEdits" // file edits auto-accepted; other prompt-worthy tools still prompt
  | "plan" // read-only planning: edits/writes blocked
  | "auto" // classifier-gated: runs everything, blocks irreversible/destructive/exfiltrating actions
  | "dontAsk" // auto-DENIES anything that would prompt; only pre-approved tools run (CI)
  | "bypassPermissions"; // DANGER: never prompt — allow every tool

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
];
```

This is **additive to a string union already carried on existing envelopes**, so `PROTOCOL_VERSION`
stays **5** (design §5 constraint 5).

**Step 2: Verify the CLI accepts both**

Run: `claude --help | grep -A3 'permission-mode'`
Expected: the choices list contains `auto` and `dontAsk`. If it does not, the installed CC predates
them — stop and upgrade before continuing.

**Step 3: Regenerate the golden**

Run: `bun test/contract/regen-golden.ts`
Then: `bun test test/contract/`
Expected: PASS. `protocolVersion` must still read `5`; only wire types change if at all.

**Step 4: Typecheck both projects**

Run: `bun run typecheck && bun run typecheck:web`
Expected: clean. A web break here is the designed detector for a missed picker site.

**Step 5: Commit**

`git commit -m "feat(protocol): PermissionMode gains auto + dontAsk (additive, v5 unchanged)"`

---

## Task 20: `auto` becomes the new-session default

**Files:**
- Modify: `anvild/web/src/dialogs.ts:283` (`DEFAULT_PERMISSION_MODE`) and the picker at `:285`
- Modify: `anvild/src/cc/turn-runner.ts` (fallback mode)
- Create: `anvild/test/unit/permission-mode-default.test.ts`

**Step 1: Write failing test**

`anvild/test/unit/permission-mode-default.test.ts`:

```ts
/**
 * `auto` replaces `bypassPermissions` as the default for new sessions (cc-config design D-6).
 * 3084128 mapped the old `mostly-autonomous` policy onto `bypassPermissions` as "the closest
 * behavioral match", which kept the rarely-prompted half and dropped the destructive-action floor.
 * CC's classifier restores the floor without Anvil owning any of the logic.
 *
 * `claude -p` does NOT inherit CC's new built-in default — the docs are explicit that -p starts in
 * `default` — so the turn-runner must pass the mode explicitly or the session gets nothing.
 */
import { test, expect } from "bun:test";
import { PERMISSION_MODES, isPermissionMode } from "@protocol";

test("auto and dontAsk are valid protocol permission modes", () => {
  expect(isPermissionMode("auto")).toBe(true);
  expect(isPermissionMode("dontAsk")).toBe(true);
  expect(PERMISSION_MODES).toContain("auto");
});

test("the turn-runner's fallback mode is auto, not default or bypassPermissions", async () => {
  const src = await Bun.file(`${import.meta.dir}/../../src/cc/turn-runner.ts`).text();
  // The spawn line reads: s.data.permissionMode ?? this.deps.permissionMode ?? "<fallback>"
  const m = src.match(/permissionMode\s*\?\?\s*this\.deps\.permissionMode\s*\?\?\s*"([a-zA-Z]+)"/);
  expect(m?.[1]).toBe("auto");
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/permission-mode-default.test.ts`
Expected: FAIL — fallback is currently `"default"`

**Step 3: Implement**

In `src/cc/turn-runner.ts`, change the spawn fallback:

```ts
      // The session's own mode, 1:1 with the CLI engine (protocol delta 1); re-read every spawn so a
      // mid-conversation session.set_permission_mode lands on the next turn. Fallback is `auto`:
      // `claude -p` does NOT inherit CC's built-in auto default (docs are explicit that -p starts in
      // `default`), so an unset mode must be named explicitly or the session loses the classifier.
      "--permission-mode", s.data.permissionMode ?? this.deps.permissionMode ?? "auto",
```

In `web/src/dialogs.ts`, change the default and the picker:

```ts
// New sessions default to "auto" — CC's classifier blocks irreversible/destructive actions while
// keeping the session unattended. Replaces the old "bypassPermissions" default, which had no floor.
const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";
const PERMISSION_PICKER = `
  <option value="auto" data-icon="shield" selected>Auto — run freely, classifier blocks destructive actions</option>
  <option value="default" data-icon="pause">Manual — ask before most actions</option>
  <option value="acceptEdits" data-icon="edit">Accept edits — auto-approve file edits</option>
  <option value="plan" data-icon="map">Plan — read-only</option>
  <option value="dontAsk" data-icon="lock">Don't ask — only pre-approved tools (CI)</option>
  <option value="bypassPermissions" data-icon="bolt">Bypass — skip all checks ⚠️</option>`;
```

**Step 4: Verify**

Run: `bun test test/unit/permission-mode-default.test.ts && bun run typecheck && bun run typecheck:web && bun run build:web`
Expected: all pass.

**Step 5: Commit**

`git commit -m "feat(cc-config): auto is the new-session default, restoring the destructive-action floor"`

---

## Task 21: Sync diff computation — **CARRIED (extended)**

Follow superseded plan **Task 13**, then extend the diff to `autoMode`: compare the four prose arrays
by exact string set. **Memory is NOT in the diff** — Phase B (design §8).

Add a test asserting memory is absent from the diff result, so a later contributor cannot add it
without deciding the merge semantics first.

`git commit -m "feat(cc-config): sync diff over plugins, MCP, autoMode"`

## Task 22: Sync REST endpoint — **CARRIED**

Follow superseded plan **Task 18**, renamed.

`git commit -m "feat(cc-config): sync REST endpoint"`

## Task 23: Web — `ccconfig.ts` seam + Settings section shell — **CARRIED**

Follow superseded plan **Task 14**, renamed. The seam follows the `initX(deps)` pattern used by every
other web module (`initFleet`, `initSettings`, …): no seam imports `main.ts`, and scalars reassigned
across modules live on the `ui` object in `state.ts`.

`git commit -m "feat(web): Settings → Claude Code shell + ccconfig seam"`

## Task 24: Web — plugin + MCP rendering and actions — **CARRIED**

Follow superseded plan **Tasks 15, 16, 17**, renamed. Use `modalPromise`/`showModal` and the `busy()`
helper from `dom.ts` for all dialogs and buttons.

`git commit -m "feat(web): plugin + MCP sections"`

---

## Task 25: Web — auto-mode editor with `$defaults` guard

**Files:**
- Modify: `anvild/web/src/ccconfig.ts`
- Create: `anvild/test/web/ccconfig-automode.test.ts`

**Step 1: Write failing test**

```ts
/**
 * The auto-mode editor's one job beyond rendering: make the `$defaults` footgun impossible to hit by
 * accident. Saving a section WITHOUT the literal "$defaults" discards CC's entire built-in list for
 * that section — silently, with no CLI error. The editor seeds it and warns loudly if removed.
 */
import { test, expect, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";
import { renderAutoModeSection, defaultsWarning } from "../../web/src/ccconfig";

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  (globalThis as unknown as { document: Document }).document = dom.window.document;
});

test("a new section is seeded with $defaults", () => {
  const el = renderAutoModeSection("soft_deny", [], ["builtin-1"]);
  expect(el.querySelector("textarea")!.value.split("\n")[0]).toBe("$defaults");
});

test("no warning when $defaults is present", () => {
  expect(defaultsWarning(["$defaults", "mine"], 12)).toBe(null);
});

test("removing $defaults warns and names how many built-ins would be lost", () => {
  const w = defaultsWarning(["mine"], 12);
  expect(w).toContain("12");
  expect(w?.toLowerCase()).toContain("discard");
});

test("an empty section also warns — [] discards the defaults too", () => {
  expect(defaultsWarning([], 12)).not.toBe(null);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/web/ccconfig-automode.test.ts`
Expected: FAIL — exports missing

**Step 3: Implement** (in `web/src/ccconfig.ts`)

```ts
/** Null when the edit inherits CC's built-ins; otherwise the warning to show before saving. */
export function defaultsWarning(entries: string[], builtinCount: number): string | null {
  if (entries.includes("$defaults")) return null;
  return `This section omits $defaults, so saving will discard all ${builtinCount} of Claude Code's built-in rules for it. Add "$defaults" to keep them.`;
}

export function renderAutoModeSection(name: string, entries: string[], builtins: string[]): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "cc-automode-section";
  const seeded = entries.length ? entries : ["$defaults"];
  wrap.innerHTML = `
    <h4>${name}</h4>
    <textarea rows="6" spellcheck="false"></textarea>
    <p class="cc-automode-warn" hidden></p>
    <p class="cc-automode-effective">${builtins.length} built-in rules available</p>`;
  const ta = wrap.querySelector("textarea") as HTMLTextAreaElement;
  ta.value = seeded.join("\n");
  const warn = wrap.querySelector(".cc-automode-warn") as HTMLElement;
  const sync = (): void => {
    const lines = ta.value.split("\n").map((l) => l.trim()).filter(Boolean);
    const w = defaultsWarning(lines, builtins.length);
    warn.textContent = w ?? "";
    warn.hidden = w === null;
  };
  ta.addEventListener("input", sync);
  sync();
  return wrap;
}
```

**Step 4: Run test, verify pass**

Run: `bun test test/web/ccconfig-automode.test.ts && bun run typecheck:web && bun run build:web`
Expected: PASS + clean.

**Step 5: Commit**

`git commit -m "feat(web): auto-mode editor with \$defaults discard guard"`

---

## Task 26: Web — memory browser/editor

**Files:**
- Modify: `anvild/web/src/ccconfig.ts`
- Create: `anvild/test/web/ccconfig-memory.test.ts`

**Step 1: Write failing test**

```ts
/**
 * The memory section replaces the TUI-only /memory. MEMORY.md is rendered first and flagged as the
 * only file loaded every session; the budget warning must appear BEFORE saving, because CC accepts an
 * over-budget write and then drops the overflow on next load.
 */
import { test, expect, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";
import { renderMemoryList, budgetLabel } from "../../web/src/ccconfig";

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  (globalThis as unknown as { document: Document }).document = dom.window.document;
});

const files = [
  { name: "MEMORY.md", bytes: 400, modified: "2026-08-15T00:00:00.000Z" },
  { name: "debugging.md", bytes: 900, modified: "2026-08-15T00:00:00.000Z" },
];

test("MEMORY.md renders first and is marked as the always-loaded index", () => {
  const el = renderMemoryList(files, { lines: 10, bytes: 400, state: "ok" });
  const rows = el.querySelectorAll(".cc-mem-row");
  expect(rows[0]!.textContent).toContain("MEMORY.md");
  expect(rows[0]!.textContent!.toLowerCase()).toContain("loaded every session");
});

test("an empty memory dir explains itself rather than rendering blank", () => {
  const el = renderMemoryList([], { lines: 0, bytes: 0, state: "ok" });
  expect(el.textContent!.toLowerCase()).toContain("nothing remembered yet");
});

test("budgetLabel escalates ok → near → over", () => {
  expect(budgetLabel({ lines: 10, bytes: 100, state: "ok" })).toContain("10");
  expect(budgetLabel({ lines: 190, bytes: 100, state: "near" }).toLowerCase()).toContain("near");
  expect(budgetLabel({ lines: 260, bytes: 100, state: "over" }).toLowerCase()).toContain("dropped");
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/web/ccconfig-memory.test.ts`
Expected: FAIL — exports missing

**Step 3: Implement** (in `web/src/ccconfig.ts`)

```ts
interface Budget { lines: number; bytes: number; state: "ok" | "near" | "over" }
interface MemFile { name: string; bytes: number; modified: string }

export function budgetLabel(b: Budget): string {
  const base = `${b.lines} lines · ${(b.bytes / 1024).toFixed(1)} KB`;
  if (b.state === "over") return `${base} — over the limit; everything past it is dropped on the next load`;
  if (b.state === "near") return `${base} — near the 200-line / 25 KB limit`;
  return base;
}

export function renderMemoryList(files: MemFile[], indexBudget: Budget): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cc-mem-list";
  if (!files.length) {
    wrap.innerHTML = `<p class="cc-mem-empty">Nothing remembered yet. Claude writes here as it learns; you can also add notes directly.</p>`;
    return wrap;
  }
  wrap.innerHTML = files
    .map((f) => {
      const note =
        f.name === "MEMORY.md"
          ? `<span class="cc-mem-note">index · loaded every session · ${budgetLabel(indexBudget)}</span>`
          : `<span class="cc-mem-note">read on demand</span>`;
      return `<div class="cc-mem-row" data-file="${f.name}">
        <span class="cc-mem-name">${f.name}</span>${note}
        <button class="cc-mem-edit" data-file="${f.name}">Edit</button>
        <button class="cc-mem-del" data-file="${f.name}">Delete</button>
      </div>`;
    })
    .join("");
  return wrap;
}
```

Wire the Edit button to a `modalPromise` textarea that PUTs with the file's `modified` as
`expectedModified`, and on **HTTP 409** re-fetches and tells the user Claude changed the file
mid-edit, offering to reload.

**Step 4: Run test, verify pass**

Run: `bun test test/web/ccconfig-memory.test.ts && bun run typecheck:web && bun run build:web`
Expected: PASS + clean.

**Step 5: Commit**

`git commit -m "feat(web): memory browser/editor replacing TUI-only /memory"`

---

## Task 27: Web — sync diff UI — **CARRIED**

Follow superseded plan **Task 19**, renamed. **Nothing is pre-selected for removal** (design §8).

`git commit -m "feat(web): sync diff UI with per-item selection"`

## Task 28: Web DOM tests — **CARRIED**

Follow superseded plan **Task 20**, renamed.

`git commit -m "test(web): cc-config DOM coverage"`

## Task 29: Docs

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `SECURITY.md`

Add to `ARCHITECTURE.md`: `CcConfigService` in the domain-service list, and the four-domain table
from design §1.

Add to `SECURITY.md` the two hazards from design §9, stated plainly:

1. **The auto-mode classifier reads CLAUDE.md.** An instruction there steers the safety gate as well
   as the agent. CC auto-allows CLAUDE.md edits only *where the content does not change permissions,
   authorizations, or auto-mode behaviour*. The merged `claude-md-reflection.ts` writes CLAUDE.md from
   an agent turn and is in scope for that rule. Any future memory/CLAUDE.md sync moves
   classifier-steering content between machines and must be treated as privileged, not a file copy.
2. **`autoMode` is written only to `~/.claude/settings.json`.** CC deliberately excludes project
   settings from autoMode resolution so a checked-in repo cannot inject allow rules; writing there
   would reopen that hole.

`git commit -m "docs(cc-config): architecture + security notes"`

## Task 30: Live pass on hub + one member

**Not automated. Record results in the status table above.**

Per domain on the hub: install and uninstall a real plugin; add and remove an MCP server; edit an
auto-mode `allow` rule and confirm `claude auto-mode config` reflects it; edit `MEMORY.md` and confirm
the next turn sees the change. Then run one sync between the hub and one member and confirm per-item
results.

Also confirm the two behaviors that only appear live:

- A new session reports `permissionMode: auto` in its `init` line.
- Adding `Bash(git push *)` to `permissions.ask` in `~/.claude/settings.json` produces a
  `permission.request` card on the phone when the agent pushes — the human-checkpoint recipe from
  design §6.5. This is the one path that proves auto mode and Anvil's approval card compose.

`git commit -m "docs(cc-config): live pass results"`
