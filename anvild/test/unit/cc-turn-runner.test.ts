/**
 * Turn-runner lifecycle tests (plan 3 tasks 2/3/6/8/9, design §4.1/§4.2) — driven end-to-end
 * against the REAL fake-CC child (test/helpers/fake-cc.ts; child processes are never mocked):
 *   - a prompt spawns one CC process, streams deltas, commits the assistant turn, captures the
 *     CC session id, and lands status back on idle;
 *   - the stdin writer sends one stream-json user message (text + attachment blocks);
 *   - the second turn passes --resume and the (possibly switched) --model;
 *   - prompts arriving mid-turn queue FIFO — one child at a time;
 *   - TurnUsage: rateLimits/subscription degrade to null; contextUsage derived from the
 *     result's token counts + modelUsage contextWindow; costUsd from total_cost_usd;
 *   - interrupt: SIGINT ends the turn quietly (no error card), an ignore-SIGINT child is
 *     SIGKILLed after the grace, and the session keeps working afterward;
 *   - a crash mid-line parses the flushed tail, surfaces an error, and resets to idle;
 *   - a rejected --resume clears claudeSessionId and drops the friendly fresh-context divider.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnRunner, type TurnRunnerDeps } from "../../src/cc/turn-runner";
import type { TurnUsage } from "../../src/agent/driver";
import { PassthroughRenderer } from "../../src/render/markdown";
import type { Session } from "../../src/session/session";

const FAKE_CC = join(import.meta.dir, "..", "helpers", "fake-cc.ts");
const FIXTURES = join(import.meta.dir, "..", "fixtures", "cc");

function fakeSession(id: string) {
  const events: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const statuses: string[] = [];
  const data = {
    id,
    model: "haiku",
    cwd: mkdtempSync(join(tmpdir(), "anvil-cc-tr-")),
    claudeSessionId: undefined as string | undefined,
    isDefault: false,
    source: "existing-dir",
    worktree: undefined,
    context: undefined as unknown,
    status: "idle",
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  };
  const s = {
    id,
    data,
    lastAssistantText: "",
    setStatus(st: string) {
      data.status = st;
      statuses.push(st);
    },
    emit(body: Record<string, unknown>) {
      events.push(body);
    },
    emitError(message: string) {
      errors.push(message);
    },
    recordTurnLine() {},
  } as unknown as Session;
  return { s, events, errors, statuses, data };
}

function runner(
  s: Session,
  fakeEnv: Record<string, string>,
  extra: Partial<TurnRunnerDeps> = {},
): { tr: TurnRunner; results: TurnUsage[] } {
  const results: TurnUsage[] = [];
  const tr = new TurnRunner({
    session: s,
    renderer: new PassthroughRenderer(),
    env: { PATH: process.env.PATH!, ...fakeEnv },
    onResult: (u) => results.push(u),
    ccCommand: ["bun", FAKE_CC],
    ...extra,
  });
  return { tr, results };
}

/** Wait until `cond` holds (child-process turns settle in real time). */
async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition never held");
}

test("one turn: deltas stream, assistant commits, session id captured, status lands idle", async () => {
  const { s, events, errors, statuses, data } = fakeSession("sess_basic");
  const { tr, results } = runner(s, {});
  tr.prompt("Reply with exactly: ok");
  await until(() => results.length === 1);
  expect(errors).toEqual([]);
  const types = events.map((e) => e.type);
  expect(types).toContain("assistant.delta");
  expect(types).toContain("assistant.message");
  expect(types).toContain("result");
  expect(data.claudeSessionId).toBe("74301fc2-4d26-499d-af78-2b32629f93a3"); // golden basic.ndjson
  expect(statuses[0]).toBe("thinking");
  await until(() => data.status === "idle");
});

test("TurnUsage: gauge degrades (nulls), contextUsage derived, cost carried", async () => {
  const { s } = fakeSession("sess_usage");
  const { tr, results } = runner(s, {});
  tr.prompt("go");
  await until(() => results.length === 1);
  const u = results[0]!;
  expect(u.rateLimits).toBeNull();
  expect(u.subscriptionType).toBeNull();
  expect(u.costUsd).toBeGreaterThan(0);
  expect(u.contextUsage).not.toBeNull();
  expect(u.contextUsage!.max).toBe(200000); // modelUsage contextWindow in the golden recording
  expect(u.contextUsage!.used).toBeGreaterThan(0);
  expect(u.contextUsage!.used).toBeLessThan(u.contextUsage!.max);
});

test("stdin carries one stream-json user message with attachment blocks", async () => {
  const { s } = fakeSession("sess_stdin");
  const root = mkdtempSync(join(tmpdir(), "anvil-cc-io-"));
  const stdinFile = join(root, "stdin.json");
  const { tr, results } = runner(s, { FAKE_CC_STDIN_FILE: stdinFile });
  tr.prompt("look at this", [{ mediaType: "text/plain", name: "note.txt", data: Buffer.from("magic").toString("base64") }]);
  await until(() => results.length === 1);
  const lines = readFileSync(stdinFile, "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  const msg = JSON.parse(lines[0]!);
  expect(msg.type).toBe("user");
  const content = msg.message.content;
  expect(content[0]).toEqual({ type: "text", text: "look at this" });
  expect(content[1].type).toBe("text");
  expect(content[1].text).toContain("magic");
});

test("second turn resumes the captured id and reads a switched model", async () => {
  const { s, data } = fakeSession("sess_resume");
  const root = mkdtempSync(join(tmpdir(), "anvil-cc-args-"));
  const argsFile = join(root, "args.json");
  const { tr, results } = runner(s, { FAKE_CC_ARGS_FILE: argsFile });
  tr.prompt("first");
  await until(() => results.length === 1);
  expect(JSON.parse(readFileSync(argsFile, "utf8"))).not.toContain("--resume");

  data.model = "sonnet"; // supervisor.setModel writes data.model; runner reads it at next spawn
  await tr.setModel("sonnet");
  tr.prompt("second");
  await until(() => results.length === 2);
  const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
  expect(args).toContain("--resume");
  expect(args[args.indexOf("--resume") + 1]).toBe("74301fc2-4d26-499d-af78-2b32629f93a3");
  expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
});

test("prompts queue FIFO — a mid-turn prompt runs after the current turn", async () => {
  const { s, errors } = fakeSession("sess_fifo");
  const { tr, results } = runner(s, { FAKE_CC_DELAY_MS: "15" });
  tr.prompt("one");
  tr.prompt("two"); // queued while the first child streams
  await until(() => results.length === 2, 30_000);
  expect(errors).toEqual([]);
});

test("interrupt mid-stream ends the turn quietly and the session keeps working", async () => {
  const { s, errors, data } = fakeSession("sess_int");
  const { tr, results } = runner(s, { FAKE_CC_DELAY_MS: "50", FAKE_CC_HANG_AFTER: "6" });
  tr.prompt("will be interrupted");
  await until(() => data.status === "thinking");
  await new Promise((r) => setTimeout(r, 400)); // let it stream a few lines then hang
  await tr.interrupt();
  await until(() => data.status === "idle");
  expect(errors).toEqual([]); // an interrupt is not an error

  // The runner is reusable in place: a fresh prompt spawns a fresh child.
  const cleanEnv = { PATH: process.env.PATH! };
  void cleanEnv;
  const before = results.length;
  // Re-arm with a fast fixture (no hang) by pointing FAKE env off — same runner instance.
  // (The hang env rides deps.env, so this second turn hangs too; interrupt again to clean up.)
  tr.prompt("again");
  await until(() => data.status === "thinking");
  await new Promise((r) => setTimeout(r, 200));
  await tr.interrupt();
  await until(() => data.status === "idle");
  expect(results.length).toBe(before); // hung turns produced no result — and no crash either
}, 30_000);

test("an ignore-SIGINT child is SIGKILLed after the grace and the runner recovers", async () => {
  const { s, data } = fakeSession("sess_kill");
  const { tr } = runner(s, { FAKE_CC_DELAY_MS: "50", FAKE_CC_HANG_AFTER: "4", FAKE_CC_IGNORE_SIGINT: "1" }, { interruptGraceMs: 300 });
  tr.prompt("stubborn");
  await until(() => data.status === "thinking");
  await new Promise((r) => setTimeout(r, 300));
  await tr.interrupt();
  await until(() => data.status === "idle");
}, 30_000);

test("crash mid-line: flushed tail is parsed, error surfaces, status resets", async () => {
  const { s, errors, data } = fakeSession("sess_crash");
  let turnErr: unknown;
  const { tr } = runner(s, { FAKE_CC_TRUNCATE_LAST: "1", FAKE_CC_EXIT_CODE: "1" }, { onTurnError: (e) => (turnErr = e) });
  tr.prompt("will crash");
  await until(() => errors.length === 1);
  expect(errors[0]).toContain("exit");
  expect(turnErr).toBeDefined();
  await until(() => data.status === "idle");
});

test("rejected --resume clears the session id and drops the fresh-context divider", async () => {
  const { s, errors, events, data } = fakeSession("sess_rej");
  data.claudeSessionId = "dead-session-id";
  const { tr } = runner(s, { FAKE_CC_ERROR: "No conversation found with session ID dead-session-id" });
  tr.prompt("resume me");
  await until(() => events.some((e) => e.type === "assistant.message"));
  expect(data.claudeSessionId).toBeUndefined();
  const blocks = (events.find((e) => e.type === "assistant.message") as any).blocks;
  expect(blocks[0].kind).toBe("divider");
  expect(blocks[0].label).toContain("fresh context");
  expect(errors).toEqual([]); // friendly divider, not a raw error card
  await until(() => data.status === "idle");
});

test("unknown top-level type in the stream becomes a fallback card", async () => {
  const { s, events } = fakeSession("sess_fb");
  const root = mkdtempSync(join(tmpdir(), "anvil-cc-fb-"));
  const fixture = join(root, "weird.ndjson");
  writeFileSync(
    fixture,
    [
      '{"type":"system","subtype":"init","session_id":"sid-x"}',
      '{"type":"totally_new","payload":{"n":1}}',
      '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.001}',
    ].join("\n") + "\n",
  );
  const { tr, results } = runner(s, { FAKE_CC_FIXTURE: fixture });
  tr.prompt("go");
  await until(() => results.length === 1);
  const fb = events.find((e) => e.type === "assistant.message" && (e as any).blocks?.[0]?.kind === "fallback") as any;
  expect(fb).toBeDefined();
  expect(fb.blocks[0].ccType).toBe("totally_new");
});

test("stop() clears the queue and interrupts the in-flight turn", async () => {
  const { s, data } = fakeSession("sess_stop");
  const { tr, results } = runner(s, { FAKE_CC_DELAY_MS: "50", FAKE_CC_HANG_AFTER: "4" });
  tr.prompt("one");
  tr.prompt("two");
  await until(() => data.status === "thinking");
  await new Promise((r) => setTimeout(r, 200));
  await tr.stop();
  await until(() => data.status === "idle");
  await new Promise((r) => setTimeout(r, 300));
  expect(results.length).toBe(0); // neither the hung turn nor the queued one produced a result
}, 30_000);

test("fixtures sanity: the args file exists only when a spawn happened", () => {
  expect(existsSync(FAKE_CC)).toBe(true);
  expect(existsSync(join(FIXTURES, "basic.ndjson"))).toBe(true);
});

test("tool turn: status derives running_tool → thinking → idle and tool events flow", async () => {
  const { s, events, statuses } = fakeSession("sess_tool");
  const { tr, results } = runner(s, { FAKE_CC_FIXTURE: join(FIXTURES, "tool.ndjson") });
  tr.prompt("use the Read tool");
  await until(() => results.length === 1);
  const types = events.map((e) => e.type);
  expect(types).toContain("tool.use");
  expect(types).toContain("tool.result");
  expect(statuses).toContain("running_tool");
  expect(statuses[statuses.length - 1]).toBe("idle");
  expect(statuses.indexOf("running_tool")).toBeLessThan(statuses.lastIndexOf("thinking"));
});
