// Guards plan 4 task 3: per-session .mcp.json + bearer lifecycle. Tokens are minted lazily,
// stable across writes, verified constant-time-ish, and ROTATED on session reset so a stale
// config on disk can't keep talking to the daemon's approve endpoint.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcMcpConfig } from "../../src/cc/mcp-config";

function store(): CcMcpConfig {
  return new CcMcpConfig({ stateDir: mkdtempSync(join(tmpdir(), "anvil-mcp-cfg-")), host: "100.64.0.7", port: 7701 });
}

test("tokenFor mints once and is stable until rotated", () => {
  const c = store();
  const t1 = c.tokenFor("sess_a");
  expect(t1.length).toBeGreaterThanOrEqual(24);
  expect(c.tokenFor("sess_a")).toBe(t1);
  expect(c.tokenFor("sess_b")).not.toBe(t1);
  c.rotate("sess_a");
  expect(c.tokenFor("sess_a")).not.toBe(t1);
});

test("verify accepts only the exact bearer for that session", () => {
  const c = store();
  const t = c.tokenFor("sess_a");
  expect(c.verify("sess_a", `Bearer ${t}`)).toBe(true);
  expect(c.verify("sess_a", `Bearer ${c.tokenFor("sess_b")}`)).toBe(false);
  expect(c.verify("sess_a", undefined)).toBe(false);
  expect(c.verify("sess_a", t)).toBe(false); // must be a Bearer header, not a bare token
  expect(c.verify("sess_never_minted", "Bearer x")).toBe(false); // unknown session never verifies
});

test("writeConfig writes the anvild http server entry with url + bearer", () => {
  const c = store();
  const path = c.writeConfig("sess_a");
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const srv = cfg.mcpServers.anvild;
  expect(srv.type).toBe("http");
  expect(srv.url).toBe("http://100.64.0.7:7701/api/cc/mcp/sess_a");
  expect(srv.headers.Authorization).toBe(`Bearer ${c.tokenFor("sess_a")}`);
});

test("rotate + rewrite yields a config with the fresh bearer", () => {
  const c = store();
  const p1 = c.writeConfig("sess_a");
  const old = JSON.parse(readFileSync(p1, "utf8")).mcpServers.anvild.headers.Authorization;
  c.rotate("sess_a");
  const p2 = c.writeConfig("sess_a");
  expect(p2).toBe(p1); // same path per session
  const fresh = JSON.parse(readFileSync(p2, "utf8")).mcpServers.anvild.headers.Authorization;
  expect(fresh).not.toBe(old);
});

test("wildcard/unspecified bind hosts fall back to loopback in the URL", () => {
  const c = new CcMcpConfig({ stateDir: mkdtempSync(join(tmpdir(), "anvil-mcp-cfg-")), host: "0.0.0.0", port: 7701 });
  const cfg = JSON.parse(readFileSync(c.writeConfig("s"), "utf8"));
  expect(cfg.mcpServers.anvild.url).toContain("http://127.0.0.1:7701/");
});

// ── plan 5 tasks 2+3: role tool-server entries + the additive settings overlay ────────────────
test("writeConfig adds role tool servers beside anvild, same bearer", () => {
  const c = store();
  const cfg = JSON.parse(readFileSync(c.writeConfig("sess_a", ["anvil_team"]), "utf8"));
  expect(Object.keys(cfg.mcpServers).sort()).toEqual(["anvil_team", "anvild"]);
  expect(cfg.mcpServers.anvil_team.url).toBe("http://100.64.0.7:7701/api/cc/mcp/sess_a/anvil_team");
  expect(cfg.mcpServers.anvil_team.headers.Authorization).toBe(cfg.mcpServers.anvild.headers.Authorization);
});

test("writeConfig with no role servers keeps just anvild (plain sessions)", () => {
  const c = store();
  const cfg = JSON.parse(readFileSync(c.writeConfig("sess_b"), "utf8"));
  expect(Object.keys(cfg.mcpServers)).toEqual(["anvild"]);
});

test("settings overlay carries ONLY the additive Stop hook with a bearer curl", () => {
  const c = store();
  const path = c.writeSettingsOverlay("sess_a", { goalStopHook: true });
  const overlay = JSON.parse(readFileSync(path!, "utf8"));
  expect(Object.keys(overlay)).toEqual(["hooks"]); // additive: nothing else is overridden
  const hook = overlay.hooks.Stop[0].hooks[0];
  expect(hook.type).toBe("command");
  expect(hook.command).toContain("http://100.64.0.7:7701/api/cc/hook/sess_a/stop");
  expect(hook.command).toContain(`Bearer ${c.tokenFor("sess_a")}`);
  expect(hook.command).toContain("--data-binary @-"); // stdin JSON forwarded to the daemon
});

test("settings overlay is skipped entirely when no anvil hooks apply", () => {
  const c = store();
  expect(c.writeSettingsOverlay("sess_a", { goalStopHook: false })).toBeUndefined();
});
