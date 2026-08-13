// CC-native permission path (cc plan 4): the PreToolUse hook no longer decides — CC's/the
// SDK's own engine does, and prompt-worthy asks park through askPermission (the shared core of
// the MCP approve tool and the SDK canUseTool). The hook's only remaining job is the advisory
// ExitPlanMode plan review, and letting everything fall through undecided.
import { test, expect } from "bun:test";
import { PermissionBroker, askPermission, makePreToolUseHook } from "../../src/agent/permissions";
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

const ctx = { signal: new AbortController().signal } as any;

test("the hook never decides — every tool falls through with a bare continue", async () => {
  const hook = makePreToolUseHook(fakeSession().s, new PermissionBroker());
  for (const tool of ["AskUserQuestion", "Read", "Bash", "Write"]) {
    const out = (await hook({ tool_name: tool, tool_input: {} } as any, "t", ctx)) as any;
    expect(out).toEqual({ continue: true });
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  }
});

test("ExitPlanMode runs the plan-review hook with the plan text (advisory)", async () => {
  const seen: string[] = [];
  const hook = makePreToolUseHook(fakeSession().s, new PermissionBroker(), async (plan) => {
    seen.push(plan);
  });
  const out = (await hook({ tool_name: "ExitPlanMode", tool_input: { plan: "## Step 1" } } as any, "t", ctx)) as any;
  expect(seen).toEqual(["## Step 1"]);
  expect(out).toEqual({ continue: true }); // advisory: the engine still decides
});

test("plan review is advisory — a throwing reviewer never blocks ExitPlanMode", async () => {
  const hook = makePreToolUseHook(fakeSession().s, new PermissionBroker(), async () => {
    throw new Error("openrouter down");
  });
  const out = (await hook({ tool_name: "ExitPlanMode", tool_input: { plan: "x" } } as any, "t", ctx)) as any;
  expect(out).toEqual({ continue: true });
});

test("the plan-review hook does NOT fire for ordinary tools", async () => {
  let fired = false;
  const hook = makePreToolUseHook(fakeSession().s, new PermissionBroker(), async () => {
    fired = true;
  });
  await hook({ tool_name: "Read", tool_input: {} } as any, "t", ctx);
  expect(fired).toBe(false);
});

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
