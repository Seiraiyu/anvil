/**
 * `auto` replaces `bypassPermissions` as the default for new sessions (cc-config design D-6).
 * 3084128 mapped the old `mostly-autonomous` policy onto `bypassPermissions` as "the closest
 * behavioral match", which kept the rarely-prompted half and dropped the destructive-action floor.
 * CC's classifier restores the floor without Anvil owning any of the logic.
 *
 * `claude -p` does NOT inherit CC's new built-in default — the docs are explicit that -p starts in
 * `default` — so the turn-runner must pass the mode explicitly or the session gets nothing.
 *
 * The default lives in more places than the picker: the supervisor stamps a concrete mode onto every
 * session record at create time, so `session.create` from a stale client, the `session_handoff` MCP
 * tool, autopilot, and the default "Claude" session each carry their own fallback. Missing any one of
 * them leaves that path on `bypassPermissions` while the UI claims the default is `auto`. These are
 * source-level assertions on purpose: they pin the literal at each site cheaply, where a behavioural
 * test would need a live supervisor per path.
 */
import { test, expect } from "bun:test";
import { PERMISSION_MODES, isPermissionMode } from "@protocol";

const read = (rel: string) => Bun.file(`${import.meta.dir}/../../${rel}`).text();

test("auto and dontAsk are valid protocol permission modes", () => {
  expect(isPermissionMode("auto")).toBe(true);
  expect(isPermissionMode("dontAsk")).toBe(true);
  expect(PERMISSION_MODES).toContain("auto");
});

test("the turn-runner's fallback mode is auto, not default or bypassPermissions", async () => {
  const src = await read("src/cc/turn-runner.ts");
  // The spawn line reads: s.data.permissionMode ?? this.deps.permissionMode ?? "<fallback>"
  const m = src.match(/permissionMode\s*\?\?\s*this\.deps\.permissionMode\s*\?\?\s*"([a-zA-Z]+)"/);
  expect(m?.[1]).toBe("auto");
});

test("session.create stamps auto when the client sends no mode", async () => {
  const src = await read("src/session/supervisor.ts");
  const m = src.match(/permissionMode:\s*cmd\.permissionMode\s*\?\?\s*"([a-zA-Z]+)"/);
  expect(m?.[1]).toBe("auto");
});

test("the default 'Claude' session is created in auto", async () => {
  const src = await read("src/session/supervisor.ts");
  // The seeded default session sets the mode as a bare literal, not via a `??` fallback.
  expect(src).toContain('permissionMode: "auto"');
  expect(src).not.toContain('permissionMode: "bypassPermissions"');
});

test("autopilot's BUILD session falls back to auto; its PLANNING session stays interactive", async () => {
  const src = await read("src/session/autopilot-service.ts");
  const at = (fn: string) => {
    const i = src.indexOf(`async ${fn}(`);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, i + 3000).match(/permissionMode:\s*permissionMode\s*\?\?\s*"([a-zA-Z]+)"/)?.[1];
  };
  // startPlan seeds a worktree session that builds unattended — it wants the D-6 default.
  expect(at("startPlan")).toBe("auto");
  // startPlanningSession is deliberately interactive: it exists to ask the open questions rather
  // than blast ahead (protocol: AutopilotPlanCmd defaults to "default"). That is a considered
  // per-path override, NOT a site the D-6 sweep missed — leave it alone.
  expect(at("startPlanningSession")).toBe("default");
});

test("the session_handoff MCP tool can express every protocol mode and defaults to auto", async () => {
  const src = await read("src/agent/default-tools.ts");
  // A lead agent must be able to request the default it is told about; an enum missing `auto`
  // rejects the value outright rather than falling back. Pin the enum to the protocol constant so
  // the next added mode is reachable for free instead of silently unsupported here.
  const m = src.match(/permissionMode:\s*z[\s\S]{0,400}?\.enum\(([^)]*)\)/);
  expect(m?.[1]).toContain("PERMISSION_MODES");
  expect(m?.[1]).not.toMatch(/"[a-zA-Z]+"/); // no hand-copied literal list
  expect(src).toContain("default auto");
});

test("the web picker defaults to auto", async () => {
  const src = await Bun.file(`${import.meta.dir}/../../web/src/dialogs.ts`).text();
  const m = src.match(/DEFAULT_PERMISSION_MODE:\s*PermissionMode\s*=\s*"([a-zA-Z]+)"/);
  expect(m?.[1]).toBe("auto");
  // The `selected` attribute must sit on the same option the constant names, or a picker that is
  // never touched submits a different mode than the one the code claims is the default.
  const sel = src.match(/<option value="([a-zA-Z]+)"[^>]*\bselected\b/);
  expect(sel?.[1]).toBe("auto");
});
