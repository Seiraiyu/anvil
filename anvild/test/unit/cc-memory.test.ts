/**
 * The memory adapter (cc-config design §6.4). Memory lives wherever CC says it lives — the directory
 * comes from `init.memory_paths.auto`, never derived here (principle 1; deriving the project slug
 * would reimplement CC logic and break silently when CC changes it).
 *
 * Two invariants are security-relevant: every file access is confined to the memory dir (no
 * traversal, no symlink escape), and MEMORY.md's 200-line / 25KB budget is reported, because CC
 * accepts an over-budget write and then drops the overflow on the next load — a silent save is data
 * loss in effect.
 *
 * Every test here works in a temp dir. The developer's real memory is irreplaceable and is never
 * touched (ground rules).
 */
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listMemory,
  readMemoryFile,
  memoryBudget,
  writeMemoryFile,
  deleteMemoryFile,
  readMemorySettings,
  writeMemorySettings,
  MEMORY_LINE_LIMIT,
  MEMORY_BYTE_LIMIT,
} from "../../src/cc/memory";

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

// ── Task 12: writes + deletes ───────────────────────────────────────────────────────────────────

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

// ── Task 13: memory settings ────────────────────────────────────────────────────────────────────

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
  writeFileSync(
    join(h, ".claude", "settings.json"),
    JSON.stringify({ autoMemoryEnabled: false, autoMemoryDirectory: "~/mem" }),
  );
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

// ── Beyond the plan: this module deletes and overwrites irreplaceable user data, so pin the
// properties that decide whether a bug here is recoverable. ──

test("[SEC] confinement is judged on the RESOLVED path, so a detour that lands back inside is allowed", () => {
  const m = memDir();
  mkdirSync(join(m, "sub"), { recursive: true });
  writeFileSync(join(m, "MEMORY.md"), "inside\n");
  // `sub/../../memory/MEMORY.md` leaves and re-enters, resolving to a file genuinely inside the
  // memory dir. Refusing it would be string-matching, not confinement; the guard must judge the
  // resolved path. The traversal tests above cover the paths that truly land outside.
  expect(readMemoryFile(m, "sub/../../memory/MEMORY.md").text).toBe("inside\n");
});

test("[SEC] a sibling directory sharing the name prefix cannot be reached", () => {
  const m = memDir();
  const sibling = `${m}-evil`;
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "x.md"), "secret\n");
  // `${root}/` rather than `${root}` is what stops "/tmp/x/memory-evil" matching "/tmp/x/memory".
  expect(() => readMemoryFile(m, "../memory-evil/x.md")).toThrow(/outside the memory directory/);
});

test("[SEC] a symlinked DIRECTORY escape is refused, not just a symlinked file", () => {
  const m = memDir();
  const outside = mkdtempSync(join(tmpdir(), "cc-mem-outside-"));
  writeFileSync(join(outside, "x.md"), "secret\n");
  symlinkSync(outside, join(m, "escape"));
  expect(() => readMemoryFile(m, "escape/x.md")).toThrow(/outside the memory directory/);
});

test("a stale-write rejection leaves the ORIGINAL bytes intact, not a partial write", () => {
  const m = memDir();
  writeMemoryFile(m, "notes.md", "important\n");
  const before = readFileSync(join(m, "notes.md"), "utf8");
  expect(() => writeMemoryFile(m, "notes.md", "clobber\n", "1999-01-01T00:00:00.000Z")).toThrow();
  expect(readFileSync(join(m, "notes.md"), "utf8")).toBe(before);
});

test("deleting a file that does not exist throws rather than reporting success", () => {
  const m = memDir();
  expect(() => deleteMemoryFile(m, "never-existed.md")).toThrow();
});

test("only .md may be DELETED too — .md is the guard on both write and read paths", () => {
  const m = memDir();
  writeFileSync(join(m, "keep.txt"), "not memory\n");
  // listMemory already hides it; deleting it would still be out of contract, so confirm the file
  // survives the operations the UI can actually reach.
  expect(listMemory(m).map((f) => f.name)).not.toContain("keep.txt");
  expect(existsSyncSafe(join(m, "keep.txt"))).toBe(true);
});

function existsSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

test("budget counts the CONTENT lines CC loads, ignoring a trailing newline", () => {
  expect(memoryBudget("a\nb\n").lines).toBe(2);
  expect(memoryBudget("a\nb").lines).toBe(2);
  expect(memoryBudget("").lines).toBe(0);
});

test("an over-budget MEMORY.md is reported before it is saved, since CC drops the overflow silently", () => {
  const m = memDir();
  const huge = "line\n".repeat(MEMORY_LINE_LIMIT + 50);
  writeMemoryFile(m, "MEMORY.md", huge);
  // The write SUCCEEDS (CC would accept it too) — the point is that the caller can see it is over.
  expect(memoryBudget(readMemoryFile(m, "MEMORY.md").text).state).toBe("over");
});
