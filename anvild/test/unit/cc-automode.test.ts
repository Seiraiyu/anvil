/**
 * The auto-mode adapter (cc-config design §6.5). `claude auto-mode config|defaults` are
 * non-interactive JSON, so reads are a straight parse. The `$defaults` splice is the dangerous part:
 * an array WITHOUT the literal "$defaults" silently discards CC's entire built-in list for that
 * section, so `splicedPreview` exists to show a user exactly what their edit would produce.
 *
 * Every test that writes points HOME at a temp dir. The real ~/.claude is never touched — this
 * module's writer targets the developer's own settings file by default, so that rule is not
 * negotiable here (ground rules).
 */
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseAutoModeConfig,
  splicedPreview,
  hasDefaultsSentinel,
  writeAutoModeBlock,
  AUTOMODE_SECTIONS,
  DEFAULTS_SENTINEL,
  type AutoModeConfig,
} from "../../src/cc/automode";

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

// ── Task 10: the writer. ────────────────────────────────────────────────────────────────────────

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cc-automode-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}
const empty = (): AutoModeConfig => ({ allow: [], soft_deny: [], hard_deny: [], environment: [] });

test("writeAutoModeBlock writes ONLY the autoMode key and preserves the rest of settings.json", () => {
  const home = fakeHome();
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({ autoMemoryEnabled: true, permissions: { ask: ["Bash(git push *)"] } }, null, 2),
  );

  writeAutoModeBlock({ allow: ["$defaults", "mine"], soft_deny: [], hard_deny: [], environment: ["$defaults"] }, home);

  const after = JSON.parse(readFileSync(settings, "utf8"));
  expect(after.autoMode.allow).toEqual(["$defaults", "mine"]);
  expect(after.autoMemoryEnabled).toBe(true); // untouched
  expect(after.permissions.ask).toEqual(["Bash(git push *)"]); // untouched
});

test("writeAutoModeBlock creates settings.json when absent", () => {
  const home = fakeHome();
  writeAutoModeBlock(empty(), home);
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

// ── Beyond the plan: this writer edits the file that steers the machine's safety gate, so pin the
// properties that make a bad write survivable. ──

test("an unparseable settings.json is rewritten, not merged into garbage", () => {
  const home = fakeHome();
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(settings, "{ this is not json");
  writeAutoModeBlock({ allow: ["$defaults"], soft_deny: [], hard_deny: [], environment: [] }, home);
  // CC ignores an unparseable settings file too, so recovering to a valid one is the safe move.
  const after = JSON.parse(readFileSync(settings, "utf8"));
  expect(after.autoMode.allow).toEqual(["$defaults"]);
});

test("the settings file is written 0600 — it steers the classifier", () => {
  const home = fakeHome();
  writeAutoModeBlock(empty(), home);
  const { statSync } = require("node:fs") as typeof import("node:fs");
  expect(statSync(join(home, ".claude", "settings.json")).mode & 0o777).toBe(0o600);
});

test("a rewrite replaces the previous autoMode block rather than accreting sections", () => {
  const home = fakeHome();
  writeAutoModeBlock({ allow: ["$defaults", "a"], soft_deny: ["s"], hard_deny: [], environment: [] }, home);
  writeAutoModeBlock({ allow: ["$defaults"], soft_deny: [], hard_deny: [], environment: [] }, home);
  const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  expect(after.autoMode).toEqual({ allow: ["$defaults"] }); // the stale soft_deny is gone
});

test("prose rules round-trip byte-for-byte, including the sentinel's position", () => {
  const home = fakeHome();
  const prose = parseAutoModeConfig(fixture("automode-config.json")).soft_deny;
  writeAutoModeBlock({ allow: [], soft_deny: [DEFAULTS_SENTINEL, ...prose], hard_deny: [], environment: [] }, home);
  const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  expect(after.autoMode.soft_deny).toEqual([DEFAULTS_SENTINEL, ...prose]);
});

test("[SEC] the writer only ever targets <home>/.claude/settings.json", () => {
  const home = fakeHome();
  writeAutoModeBlock(empty(), home);
  // A project settings file must never appear — CC excludes project scope from autoMode resolution
  // precisely so a checked-in repo cannot inject allow rules (design §9).
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
  expect(existsSync(join(home, ".claude", "settings.local.json"))).toBe(false);
});
