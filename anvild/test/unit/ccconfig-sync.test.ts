/**
 * Cross-box sync diff (design §4.4). The load-bearing property is that sync never mutates
 * implicitly: installs are pre-selected, REMOVALS ARE NOT, so a careless click cannot wipe a
 * member's local extras. Per-box uniqueness is the point of the feature.
 */
import { test, expect } from "bun:test";
import { diffPlugins, diffMcp, diffAutoMode, diffConfig } from "../../src/session/ccconfig-sync";
import type { PluginInfo } from "../../src/cc/plugins";
import type { McpServerInfo } from "../../src/cc/mcp";

const p = (id: string, version = "1.0.0"): PluginInfo => {
  const [name, marketplace = ""] = id.split("@");
  return { id, name: name!, marketplace, version, enabled: true, scope: "user", mcpServers: [] };
};
const m = (name: string): McpServerInfo => ({ name, connected: true });
const EMPTY = { allow: [], soft_deny: [], hard_deny: [], environment: [] };

test("items on source but not target are installs", () => {
  const d = diffPlugins([p("a@m"), p("b@m")], [p("a@m")]);
  expect(d.install.map((x) => x.id)).toEqual(["b@m"]);
  expect(d.remove).toEqual([]);
});

test("items only on target are removals — and are never pre-selected", () => {
  const d = diffPlugins([p("a@m")], [p("a@m"), p("local@m")]);
  expect(d.remove.map((x) => x.id)).toEqual(["local@m"]);
  expect(d.remove.every((x) => x.selected === false)).toBe(true);
  expect(d.install.every((x) => x.selected === true)).toBe(true);
});

test("a version difference is reported separately from an install", () => {
  const d = diffPlugins([p("a@m", "2.0.0")], [p("a@m", "1.0.0")]);
  expect(d.update).toHaveLength(1);
  expect(d.update[0]).toMatchObject({ id: "a@m", sourceVersion: "2.0.0", targetVersion: "1.0.0" });
  expect(d.install).toEqual([]);
});

test("identical sets produce an empty diff", () => {
  const d = diffPlugins([p("a@m")], [p("a@m")]);
  expect(d.install.length + d.remove.length + d.update.length).toBe(0);
});

// ── MCP + auto mode ─────────────────────────────────────────────────────────────────────────────

test("MCP servers diff by name, with removals unselected like plugins", () => {
  const d = diffMcp([m("sentry"), m("gh")], [m("sentry"), m("local-only")]);
  expect(d.add.map((x) => x.id)).toEqual(["gh"]);
  expect(d.add.every((x) => x.selected)).toBe(true);
  expect(d.remove.map((x) => x.id)).toEqual(["local-only"]);
  expect(d.remove.every((x) => x.selected === false)).toBe(true);
});

test("an MCP server present on both is NOT drift even if its target differs", () => {
  // Transport/URL is frequently machine-specific (local path, per-box port). Reporting it as drift
  // would make the diff noise the user learns to ignore.
  const source = [{ name: "local", target: "node /a/x.js", connected: true }];
  const target = [{ name: "local", target: "node /b/x.js", connected: false }];
  const d = diffMcp(source, target);
  expect(d.add).toEqual([]);
  expect(d.remove).toEqual([]);
});

test("auto-mode diffs per section, reporting added and removed prose rules", () => {
  const d = diffAutoMode(
    { ...EMPTY, allow: ["$defaults", "shared"], soft_deny: ["s1"] },
    { ...EMPTY, allow: ["$defaults"], soft_deny: ["s1"] },
  );
  expect(d).toHaveLength(1);
  expect(d[0]).toMatchObject({ section: "allow", added: ["shared"], removed: [] });
});

test("identical auto-mode config yields no sections at all", () => {
  expect(diffAutoMode({ ...EMPTY, allow: ["$defaults"] }, { ...EMPTY, allow: ["$defaults"] })).toEqual([]);
});

// ── the scope guard ─────────────────────────────────────────────────────────────────────────────

test("MEMORY IS NOT IN THE DIFF — that is a design decision (§8 Phase B), not an oversight", () => {
  const snap = { plugins: [p("a@m")], mcp: [m("sentry")], autoMode: EMPTY };
  const d = diffConfig(snap, { plugins: [], mcp: [], autoMode: EMPTY });
  // Memory is per-repo prose written by the agent on BOTH boxes, so a sync would be a merge with no
  // defined semantics, and overwriting one machine's memory with another's is unrecoverable.
  // Whoever adds it must decide those semantics first — changing this test is the decision point.
  expect(Object.keys(d).sort()).toEqual(["autoMode", "mcp", "plugins"]);
  expect(JSON.stringify(d)).not.toMatch(/memory/i);
});

test("the whole-config diff composes the three domains", () => {
  const d = diffConfig(
    { plugins: [p("a@m")], mcp: [m("s")], autoMode: { ...EMPTY, allow: ["x"] } },
    { plugins: [], mcp: [], autoMode: EMPTY },
  );
  expect(d.plugins.install.map((x) => x.id)).toEqual(["a@m"]);
  expect(d.mcp.add.map((x) => x.id)).toEqual(["s"]);
  expect(d.autoMode[0]).toMatchObject({ section: "allow", added: ["x"] });
});

test("an empty source against a populated target proposes only unselected removals", () => {
  // The "I pointed at the wrong server" case: nothing should be pre-ticked for destruction.
  const d = diffConfig({ plugins: [], mcp: [], autoMode: EMPTY }, { plugins: [p("a@m")], mcp: [m("s")], autoMode: EMPTY });
  expect(d.plugins.remove.every((r) => !r.selected)).toBe(true);
  expect(d.mcp.remove.every((r) => !r.selected)).toBe(true);
  expect(d.plugins.install).toEqual([]);
});
