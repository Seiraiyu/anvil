/**
 * Guards plan 5 tasks 2+4: the supervisor's per-session CC endpoints.
 *   - /api/cc/mcp/<id>/<server>: the role tool server (concierge session → "anvil"), bearer-gated,
 *     with a role mismatch a 404 (a member can't reach the lead's tools);
 *   - /api/cc/hook/<id>/stop: makeStopHook semantics over HTTP — no goal ⇒ {}, unmet goal ⇒
 *     {"decision":"block","reason"} (the spike-verified contract), met goal ⇒ {} + resolution,
 *     judge failure ⇒ fail-open {}.
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import type { GoalVerdict } from "../../src/agent/goal";

function harness(judge?: (c: string, t: string) => Promise<GoalVerdict>) {
  const goalJudge = async (c: string, t: string): Promise<GoalVerdict> => (judge ? judge(c, t) : { met: true, reason: "" });
  const dir = mkdtempSync(join(tmpdir(), "anvil-cc-ep-"));
  const sup = new Supervisor(
    { stateDir: dir, envFile: join(dir, "env"), port: 7701, goalJudge },
    new ConnectionRegistry(),
  );
  return { sup, dir };
}

function bearerOf(sup: Supervisor, id: string): string {
  return (sup as unknown as { ccMcpCfg: { tokenFor(id: string): string } }).ccMcpCfg.tokenFor(id);
}

function mcpReq(sup: Supervisor, id: string, body: unknown): Request {
  return new Request("http://d/x", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearerOf(sup, id)}` },
    body: JSON.stringify(body),
  });
}

test("the concierge session serves the anvil tool server; roles never cross", async () => {
  const { sup } = harness();
  const def = (sup as unknown as { defaultSession(): { id: string } }).defaultSession?.() as { id: string } | undefined;
  // The default session is created lazily by the supervisor; find it via list().
  const sessions = sup.list();
  const concierge = sessions.find((s) => s.isDefault)!;
  expect(concierge).toBeDefined();
  const list = await sup.ccMcpRequest(concierge.id, mcpReq(sup, concierge.id, { jsonrpc: "2.0", id: 1, method: "tools/list" }), "anvil");
  const body = (await list.json()) as { result: { tools: { name: string }[] } };
  expect(body.result.tools.map((t) => t.name)).toEqual(["list_sessions", "get_session", "list_environments", "create_session"]);
  // A role the session doesn't have is a 404, even with a valid bearer.
  const cross = await sup.ccMcpRequest(concierge.id, mcpReq(sup, concierge.id, { jsonrpc: "2.0", id: 1, method: "tools/list" }), "anvil_team");
  expect(cross.status).toBe(404);
  void def;
});

async function stopHook(sup: Supervisor, id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await sup.ccStopHook(
    id,
    new Request("http://d/x", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearerOf(sup, id)}` },
      body: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

test("stop hook: no goal ⇒ {}; unmet ⇒ block with reason; met ⇒ {} and goal cleared", async () => {
  let met = false;
  const { sup } = harness(async () => ({ met, reason: met ? "" : "tests still failing" }));
  const s = await sup.create({ v: 5, ts: "t", type: "session.create", source: "existing-dir", cwd: mkdtempSync(join(tmpdir(), "anvil-cc-ep-cwd-")) } as never);

  // no goal — free path
  expect((await stopHook(sup, s.data.id)).body).toEqual({});

  // unmet goal — the spike-verified blocking contract
  s.data.goal = { condition: "tests pass", iterations: 0, setAt: "t" } as never;
  const blocked = await stopHook(sup, s.data.id);
  expect(blocked.body.decision).toBe("block");
  expect(String(blocked.body.reason)).toContain("tests pass");
  expect(String(blocked.body.reason)).toContain("tests still failing");
  expect((s.data.goal as { iterations: number }).iterations).toBe(1);

  // met goal — cleared + free reply
  met = true;
  expect((await stopHook(sup, s.data.id)).body).toEqual({});
  expect(s.data.goal).toBeUndefined();
});

test("stop hook fails open when the judge throws", async () => {
  const { sup } = harness(async () => {
    throw new Error("judge unreachable");
  });
  const s = await sup.create({ v: 5, ts: "t", type: "session.create", source: "existing-dir", cwd: mkdtempSync(join(tmpdir(), "anvil-cc-ep-cwd2-")) } as never);
  s.data.goal = { condition: "x", iterations: 0, setAt: "t" } as never;
  expect((await stopHook(sup, s.data.id)).body).toEqual({}); // D6: never trap the session
});

test("both endpoints refuse a bad bearer", async () => {
  const { sup } = harness();
  const s = await sup.create({ v: 5, ts: "t", type: "session.create", source: "existing-dir", cwd: mkdtempSync(join(tmpdir(), "anvil-cc-ep-cwd3-")) } as never);
  const bad = new Request("http://d/x", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
  expect((await sup.ccMcpRequest(s.data.id, bad, "anvil")).status).toBe(401);
  expect((await sup.ccStopHook(s.data.id, bad.clone())).status).toBe(401);
});
