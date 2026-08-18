/**
 * Guard tests for the Settings → Claude Code seam (web/src/ccconfig.ts).
 *
 * Two contracts are worth more than the rendering itself:
 *  - the `$defaults` guard. Saving an auto-mode section WITHOUT the literal "$defaults" silently
 *    discards CC's entire built-in list for it, with no CLI error. The editor seeds the sentinel and
 *    warns loudly when it is removed — this is the only thing standing between a user and a quietly
 *    disarmed classifier.
 *  - escaping + secret hygiene. MCP configs carry headers, env and tokens; rows must show name,
 *    target and status ONLY (design §8), and every interpolated value must be escaped.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";

let cc: typeof import("../../web/src/ccconfig");

const HTML = `<!doctype html><html><body><div id="ccconfig-cards"></div></body></html>`;

beforeAll(async () => {
  installDom({ html: HTML });
  cc = await import("../../web/src/ccconfig");
});
afterAll(() => uninstallDom());
beforeEach(() => {
  document.getElementById("ccconfig-cards")!.innerHTML = "";
});

// ── the $defaults guard ─────────────────────────────────────────────────────────────────────────

test("a new section is seeded with $defaults", () => {
  const el = cc.renderAutoModeSection("soft_deny", [], ["builtin-1"]);
  expect(el.querySelector("textarea")!.value.split("\n")[0]).toBe("$defaults");
});

test("no warning when $defaults is present", () => {
  expect(cc.defaultsWarning(["$defaults", "mine"], 12)).toBe(null);
});

test("removing $defaults warns and names how many built-ins would be lost", () => {
  const w = cc.defaultsWarning(["mine"], 12);
  expect(w).toContain("12");
  expect(w?.toLowerCase()).toContain("discard");
});

test("an empty section also warns — [] discards the defaults too", () => {
  expect(cc.defaultsWarning([], 12)).not.toBe(null);
});

test("the warning appears live as the user deletes $defaults, not only on save", () => {
  const el = cc.renderAutoModeSection("allow", ["$defaults", "mine"], ["b1", "b2"]);
  const warn = el.querySelector<HTMLElement>(".am-warn")!;
  expect(warn.classList.contains("hidden")).toBe(true);
  const ta = el.querySelector<HTMLTextAreaElement>("textarea")!;
  ta.value = "mine";
  ta.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("input"));
  expect(warn.classList.contains("hidden")).toBe(false);
  expect(warn.textContent).toContain("2");
});

test("section text round-trips through the editor, dropping blanks and keeping order", () => {
  expect(cc.parseSectionText("$defaults\n\n  rule one  \nrule two\n\n")).toEqual([
    "$defaults",
    "rule one",
    "rule two",
  ]);
});

test("collectAutoMode reads all four sections back out", () => {
  const root = document.createElement("div");
  for (const s of cc.AUTOMODE_SECTIONS) root.appendChild(cc.renderAutoModeSection(s, [`${s}-rule`], []));
  expect(cc.collectAutoMode(root)).toEqual({
    allow: ["allow-rule"],
    soft_deny: ["soft_deny-rule"],
    hard_deny: ["hard_deny-rule"],
    environment: ["environment-rule"],
  });
});

// ── escaping + secret hygiene ───────────────────────────────────────────────────────────────────

test("[SEC] plugin rows escape every interpolated value", () => {
  const html = cc.pluginRowsMarkup([
    {
      id: '"><script>alert(1)</script>',
      name: '<img src=x onerror=alert(1)>',
      marketplace: "m&m",
      version: "1<2",
      enabled: true,
      scope: "user",
      mcpServers: [],
    },
  ]);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;script&gt;");
});

test("[SEC] MCP rows render name/target/status only — never a config, header or token", () => {
  const html = cc.mcpRowsMarkup([{ name: "sentry", target: "https://mcp.sentry.dev/mcp", connected: true }]);
  expect(html).toContain("sentry");
  expect(html).toContain("https://mcp.sentry.dev/mcp");
  expect(html).toContain("✔ connected");
  // The row markup has no seam through which a header/env value could reach the DOM.
  expect(html.toLowerCase()).not.toContain("authorization");
  expect(html.toLowerCase()).not.toContain("token");
});

test("an unparseable MCP line is shown verbatim rather than dropped", () => {
  const html = cc.mcpRowsMarkup([{ name: "┌─ weird new format ─┐", connected: false, raw: true }]);
  expect(html).toContain("couldn't parse");
  expect(html).toContain("weird new format");
});

test("a disconnected server reads as needing attention, not as absent", () => {
  const html = cc.mcpRowsMarkup([{ name: "gh", target: "x", connected: false }]);
  expect(html).toContain("⚠ needs attention");
});

test("empty states are explicit rather than a blank panel", () => {
  expect(cc.pluginRowsMarkup([])).toContain("No plugins installed");
  expect(cc.mcpRowsMarkup([])).toContain("No MCP servers configured");
  expect(cc.memoryRowsMarkup([])).toContain("No memory files");
});

test("memory rows show a human size and escape the filename", () => {
  const html = cc.memoryRowsMarkup([{ name: "<b>x</b>.md", bytes: 2048, modified: "2026-01-01T00:00:00.000Z" }]);
  expect(html).toContain("2.0 KB");
  expect(html).not.toContain("<b>x</b>");
});

test("fmtBytes switches to KB above 1024", () => {
  expect(cc.fmtBytes(512)).toBe("512 B");
  expect(cc.fmtBytes(1536)).toBe("1.5 KB");
});

test("a disabled plugin offers Enable, an enabled one offers Disable", () => {
  const row = (enabled: boolean) =>
    cc.pluginRowsMarkup([
      { id: "a@m", name: "a", marketplace: "m", version: "1", enabled, scope: "user", mcpServers: [] },
    ]);
  expect(row(true)).toContain('data-op="disable"');
  expect(row(false)).toContain('data-op="enable"');
  expect(row(false)).toContain("disabled"); // the state is visible, not just implied by the button
});

// ── the sync diff UI (task 27) ──────────────────────────────────────────────────────────────────

type SyncDiffShape = Parameters<typeof cc.syncDiffMarkup>[0];

const emptyDiff = (): SyncDiffShape => ({
  plugins: { install: [], remove: [], update: [] },
  mcp: { add: [], remove: [] },
  autoMode: [],
});

test("[SAFETY] sync removals render UNCHECKED while installs render checked", () => {
  const d = emptyDiff();
  d.plugins.install = [{ id: "new@m", name: "new", selected: true }];
  d.plugins.remove = [{ id: "local@m", name: "local", selected: false }];
  const html = cc.syncDiffMarkup(d);
  const near = (needle: string) => html.slice(html.indexOf(needle), html.indexOf(needle) + 60);
  // Per-box uniqueness is the point of the feature: a careless "Apply" must not wipe local extras.
  expect(near('value="new@m"')).toContain("checked");
  expect(near('value="local@m"')).not.toContain("checked");
});

test("an identical pair says so rather than rendering an empty dialog", () => {
  expect(cc.syncDiffMarkup(emptyDiff())).toContain("already match");
});

test("MCP and auto-mode differences are described, not offered as blind copies", () => {
  const d = emptyDiff();
  d.mcp.add = [{ id: "gh", name: "gh" }];
  d.autoMode = [{ section: "allow", added: ["x"], removed: [] }];
  const html = cc.syncDiffMarkup(d);
  // Transports are machine-specific and rules are prose — neither is safe to copy without a human.
  expect(html).toContain("machine-specific");
  expect(html).toContain("not safe to copy blind");
  expect(html).not.toContain('data-sync="mcp"');
});

test("[SEC] sync rows escape plugin ids", () => {
  const d = emptyDiff();
  d.plugins.install = [{ id: '"><script>alert(1)</script>', name: "x", selected: true }];
  expect(cc.syncDiffMarkup(d)).not.toContain("<script>");
});
