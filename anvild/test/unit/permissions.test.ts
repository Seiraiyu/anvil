/**
 * CC-native permission path (cc plan 4, SDK hook removed in cc plan 7): CC's own engine decides
 * what prompts, and prompt-worthy asks park through askPermission — the core of the daemon's MCP
 * approve tool (cc/permission-server.ts).
 */
import { test, expect } from "bun:test";
import { PermissionBroker, askPermission } from "../../src/agent/permissions";
import type { Session } from "../../src/session/session";

function fakeSession() {
  const perms: { requestId: string; tool: string }[] = [];
  const allowed = new Set<string>();
  const s = {
    id: "sess_1",
    data: { permissionMode: "default", cwd: "/tmp" },
    isAlwaysAllowed: (t: string) => allowed.has(t),
    rememberAllow: (t: string) => allowed.add(t),
    requestPermission: (requestId: string, tool: string) => perms.push({ requestId, tool }),
  } as unknown as Session;
  return { s, perms, allowed };
}

test("askPermission parks, and allow/deny/allow_always map through", async () => {
  const { s, perms } = fakeSession();
  const broker = new PermissionBroker();
  const p1 = askPermission(s, broker, "Bash", { command: "rm -rf x" });
  await new Promise((r) => setTimeout(r, 5));
  expect(perms).toHaveLength(1);
  broker.resolve(perms[0]!.requestId, "deny");
  expect(await p1).toEqual({ behavior: "deny", message: "denied by user" });

  const p2 = askPermission(s, broker, "Bash", { command: "make" });
  await new Promise((r) => setTimeout(r, 5));
  broker.resolve(perms[1]!.requestId, "allow_always");
  expect((await p2).behavior).toBe("allow");
  // Remembered: the third ask short-circuits without parking.
  const p3 = await askPermission(s, broker, "Bash", { command: "make again" });
  expect(p3).toEqual({ behavior: "allow", updatedInput: { command: "make again" } });
  expect(perms).toHaveLength(2);
});
