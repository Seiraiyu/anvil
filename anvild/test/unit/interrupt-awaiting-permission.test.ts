/**
 * Guards cc plan 4 task 8 (design §7 row): interrupting a session whose turn is BLOCKED in the
 * MCP approve tool must not strand anything —
 *   - the parked broker promise force-resolves as deny (the approve handler returns, so the CLI
 *     process can wind down instead of waiting on an HTTP response forever);
 *   - the permission/question cards are retired on every device;
 *   - the driver's interrupt still runs (the process gets its SIGINT).
 * The no-prompt case stays a plain interrupt (no spurious card churn).
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import { handleCcMcp } from "../../src/cc/permission-server";

function sup(): Supervisor {
  const dir = mkdtempSync(join(tmpdir(), "anvil-int-perm-"));
  return new Supervisor({ stateDir: dir, envFile: join(dir, "env") }, new ConnectionRegistry());
}
const createCmd = (cwd: string) =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd }) as const;

function approveReq(tool: string): Request {
  return new Request("http://d/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: tool, input: { command: "rm -rf x" } } },
    }),
  });
}

test("interrupt force-denies a turn parked in approve and retires the card", async () => {
  const supervisor = sup();
  const s = await supervisor.create(createCmd(mkdtempSync(join(tmpdir(), "anvil-int-cwd-"))));
  const id = s.data.id;
  const internals = supervisor as unknown as { broker: any; questionBroker: any; drivers: Map<string, { interrupt: () => Promise<void> }> };
  let interrupted = false;
  internals.drivers.set(id, { interrupt: async () => void (interrupted = true) } as never);

  // Park an approve call exactly the way the CLI's MCP request would.
  const pending = handleCcMcp(approveReq("Bash"), {
    session: s,
    broker: internals.broker,
    questionBroker: internals.questionBroker,
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(s.data.status).toBe("awaiting_permission"); // requestPermission flipped the status

  supervisor.interrupt(id);

  const res = (await (await pending).json()) as { result: { content: { text: string }[] } };
  const decision = JSON.parse(res.result.content[0]!.text) as { behavior: string };
  expect(decision.behavior).toBe("deny"); // the CLI gets an answer, not a hang
  expect(interrupted).toBe(true); // and the process still gets its SIGINT
  // Card retired: the session's parked-prompt map is empty again.
  expect((s as unknown as { pendingPermissions: Map<string, unknown> }).pendingPermissions.size).toBe(0);
});

test("interrupt with nothing parked is a plain interrupt", async () => {
  const supervisor = sup();
  const s = await supervisor.create(createCmd(mkdtempSync(join(tmpdir(), "anvil-int-cwd2-"))));
  const internals = supervisor as unknown as { drivers: Map<string, { interrupt: () => Promise<void> }> };
  let interrupted = false;
  internals.drivers.set(s.data.id, { interrupt: async () => void (interrupted = true) } as never);
  supervisor.interrupt(s.data.id);
  expect(interrupted).toBe(true);
});
