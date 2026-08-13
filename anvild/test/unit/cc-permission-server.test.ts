/**
 * Guards plan 4 tasks 2+4 (design §4.4, Assumption 3 — spike-confirmed): the daemon's MCP
 * `approve` tool bridges CC's permission engine to the UNCHANGED brokers:
 *   - MCP plumbing: initialize / tools/list / notifications answered per the spike contract;
 *   - a prompt-worthy call parks in the PermissionBroker, fans the permission.request card,
 *     and maps allow / allow_always (remembered) / deny (+message) into the tool result;
 *   - a remembered allow_always short-circuits the re-ask inside the daemon;
 *   - AskUserQuestion routes through the SAME tool to the QuestionBroker and reproduces the
 *     questions.ts answers wire shape; skip/cancel allows with the ORIGINAL input.
 */
import { expect, test } from "bun:test";
import { handleCcMcp } from "../../src/cc/permission-server";
import { PermissionBroker } from "../../src/agent/permissions";
import { QuestionBroker } from "../../src/agent/questions";
import type { Session } from "../../src/session/session";

function fakeSession(id: string) {
  const perms: { requestId: string; tool: string; input: unknown }[] = [];
  const questions: { requestId: string; questions: unknown[] }[] = [];
  const allowed = new Set<string>();
  const s = {
    id,
    data: { id, status: "thinking" },
    requestPermission(requestId: string, tool: string, input: unknown) {
      perms.push({ requestId, tool, input });
    },
    requestQuestion(requestId: string, qs: unknown[]) {
      questions.push({ requestId, questions: qs });
    },
    rememberAllow(tool: string) {
      allowed.add(tool);
    },
    isAlwaysAllowed(tool: string) {
      return allowed.has(tool);
    },
  } as unknown as Session;
  return { s, perms, questions, allowed };
}

function deps(s: Session) {
  return { session: s, broker: new PermissionBroker(), questionBroker: new QuestionBroker() };
}

function rpc(method: string, params?: unknown, id: number | null = 1): Request {
  return new Request("http://d/api/cc/mcp/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
  });
}

async function callApprove(d: ReturnType<typeof deps>, args: Record<string, unknown>): Promise<Promise<any>> {
  const res = handleCcMcp(rpc("tools/call", { name: "approve", arguments: args }), d);
  return res.then(async (r) => JSON.parse(((await r.json()) as any).result.content[0].text));
}

test("initialize + tools/list follow the spike-verified contract", async () => {
  const d = deps(fakeSession("s1").s);
  const init = (await (await handleCcMcp(rpc("initialize", { protocolVersion: "2025-01-01" }), d)).json()) as any;
  expect(init.result.protocolVersion).toBe("2025-01-01");
  expect(init.result.serverInfo.name).toBe("anvild");
  const list = (await (await handleCcMcp(rpc("tools/list"), d)).json()) as any;
  expect(list.result.tools.map((t: any) => t.name)).toEqual(["approve"]);
  const note = await handleCcMcp(rpc("notifications/initialized", undefined, null), d);
  expect(note.status).toBe(202);
});

test("prompt-worthy call parks in the broker; allow returns behavior:allow with updatedInput", async () => {
  const { s, perms } = fakeSession("s1");
  const d = deps(s);
  const pending = callApprove(d, { tool_name: "Bash", input: { command: "rm -rf x" } });
  await new Promise((r) => setTimeout(r, 10));
  expect(perms).toHaveLength(1);
  expect(perms[0]!.tool).toBe("Bash");
  d.broker.resolve(perms[0]!.requestId, "allow", { command: "rm -rf x", sandbox: true });
  const out = await (await pending);
  expect(out).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf x", sandbox: true } });
});

test("deny maps to behavior:deny with a message", async () => {
  const { s, perms } = fakeSession("s1");
  const d = deps(s);
  const pending = callApprove(d, { tool_name: "Write", input: { file_path: "/etc/passwd" } });
  await new Promise((r) => setTimeout(r, 10));
  d.broker.resolve(perms[0]!.requestId, "deny");
  const out = await (await pending);
  expect(out.behavior).toBe("deny");
  expect(String(out.message)).toContain("denied");
});

test("allow_always remembers the tool and short-circuits the next ask", async () => {
  const { s, perms } = fakeSession("s1");
  const d = deps(s);
  const first = callApprove(d, { tool_name: "Edit", input: { a: 1 } });
  await new Promise((r) => setTimeout(r, 10));
  d.broker.resolve(perms[0]!.requestId, "allow_always");
  expect((await (await first)).behavior).toBe("allow");
  // Second ask for the same tool: answered inside the daemon, no new broker request.
  const second = await (await callApprove(d, { tool_name: "Edit", input: { b: 2 } }));
  expect(second).toEqual({ behavior: "allow", updatedInput: { b: 2 } });
  expect(perms).toHaveLength(1);
});

test("AskUserQuestion routes to the QuestionBroker and reproduces the answers shape", async () => {
  const { s, questions } = fakeSession("s1");
  const d = deps(s);
  const input = {
    questions: [{ question: "Favorite color?", header: "Color", options: [{ label: "Red" }, { label: "Green" }], multiSelect: false }],
  };
  const pending = callApprove(d, { tool_name: "AskUserQuestion", input });
  await new Promise((r) => setTimeout(r, 10));
  expect(questions).toHaveLength(1);
  d.questionBroker.resolve(questions[0]!.requestId, {
    cancelled: false,
    answers: [{ question: "Favorite color?", labels: ["Green"], notes: "please darker" }],
  });
  const out = await (await pending);
  expect(out.behavior).toBe("allow");
  expect(out.updatedInput.answers).toEqual({ "Favorite color?": "Green" });
  expect(out.updatedInput.annotations).toEqual({ "Favorite color?": { notes: "please darker" } });
  expect(out.updatedInput.questions).toEqual(input.questions); // original input round-trips
});

test("cancelled/skipped question allows with the ORIGINAL input (native skip semantics)", async () => {
  const { s, questions } = fakeSession("s1");
  const d = deps(s);
  const input = { questions: [{ question: "Q?", header: "H", options: [{ label: "A" }], multiSelect: false }] };
  const pending = callApprove(d, { tool_name: "AskUserQuestion", input });
  await new Promise((r) => setTimeout(r, 10));
  d.questionBroker.resolve(questions[0]!.requestId, { cancelled: true });
  const out = await (await pending);
  expect(out).toEqual({ behavior: "allow", updatedInput: input });
});

test("unknown tool name is a JSON-RPC error, not a crash", async () => {
  const d = deps(fakeSession("s1").s);
  const res = (await (await handleCcMcp(rpc("tools/call", { name: "nope", arguments: {} }), d)).json()) as any;
  expect(res.error).toBeDefined();
});
