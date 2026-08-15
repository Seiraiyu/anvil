// Transcript reconciler (cc plan 6 Task 2): diff the recorded golden transcript against a
// synthetic event log and verify backfill + the never-double-apply guarantee (design §7).
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@protocol";
import { reconcileTranscript } from "../../src/cc/reconcile";
import type { SessionEventBody } from "../../src/session/session";
import { PassthroughRenderer } from "../../src/render/markdown";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "cc-transcript", "transcript.jsonl");
const meta = require(join(import.meta.dir, "..", "fixtures", "cc-transcript", "meta.json"));
const renderer = new PassthroughRenderer();

/** Run one reconcile against a log of prior events; return what it emitted. */
function run(file: string, log: SessionEventBody[]) {
  const emitted: SessionEventBody[] = [];
  const outcome = reconcileTranscript(file, {
    renderer,
    events: () => log as unknown as ServerEvent[], // reconcile only reads type/ccUuid/rendered.source
    emit: (b) => emitted.push(b),
  });
  return { emitted, outcome };
}

/** A daemon-authored message.user as the supervisor logs it at prompt.send (no ccUuid). */
function daemonPrompt(text: string): SessionEventBody {
  return { type: "message.user", rendered: renderer.render(text), attachments: [] };
}

const PROMPT_A = "Use the Read tool to read note.txt, then reply with the magic word only.";
const PROMPT_B = "Reply with exactly: resumed-ok";
const PROMPT_PTY = `Reply with exactly: ${meta.ptyMarker}`;

test("empty log: backfills the whole conversation, all events uuid-stamped", () => {
  const { emitted, outcome } = run(FIXTURE, []);
  const byType = (t: string) => emitted.filter((e) => e.type === t);

  // 3 real prompts — the /exit command echo + caveat user lines are CLI-internal, filtered
  expect(byType("message.user").map((e: any) => e.rendered.source)).toEqual([PROMPT_A, PROMPT_B, PROMPT_PTY]);
  // 4 content-bearing assistant lines (3 text + 1 tool_use); thinking-only lines map to nothing
  expect(byType("assistant.message").length).toBe(4);
  expect(byType("tool.use").length).toBe(1);
  expect(byType("tool.result").length).toBe(1);
  expect(emitted.length).toBe(9);
  expect(outcome.backfilled).toBe(9);
  expect(outcome.warns).toEqual([]);
  for (const e of emitted) expect(typeof (e as any).ccUuid).toBe("string");
  // backfilled markdown rides the normal renderer pipeline
  expect((byType("message.user")[0] as any).rendered.html).toContain("magic word");
});

test("idempotent: a second run against its own output backfills nothing", () => {
  const first = run(FIXTURE, []);
  const second = run(FIXTURE, first.emitted);
  expect(second.outcome.backfilled).toBe(0);
  expect(second.emitted).toEqual([]);
});

test("daemon-logged prompts are matched by text; only the PTY turn's prompt backfills", () => {
  // Simulate: both headless turns fully live-logged (prompts + uuid-stamped stream events),
  // then the daemon was down while the PTY turn happened.
  const live = run(FIXTURE, []).emitted;
  const headlessLog: SessionEventBody[] = [
    daemonPrompt(PROMPT_A),
    daemonPrompt(PROMPT_B),
    ...live.filter((e: any) => e.type !== "message.user" && !JSON.stringify(e).includes(meta.ptyMarker)),
  ];
  const { emitted } = run(FIXTURE, headlessLog);
  const users = emitted.filter((e) => e.type === "message.user") as any[];
  expect(users.map((u) => u.rendered.source)).toEqual([PROMPT_PTY]);
  // the PTY assistant reply backfills too
  expect(emitted.some((e: any) => e.type === "assistant.message" && JSON.stringify(e.blocks).includes(meta.ptyMarker))).toBe(true);
});

test("crash mid-turn: already-streamed events are skipped by uuid, the tail heals", () => {
  const live = run(FIXTURE, []).emitted;
  // The daemon logged the prompt and the first tool_use before dying: everything with the
  // tool_use line's uuid is present; the tool.result + later assistant messages are not.
  const toolUse = live.find((e) => e.type === "tool.use") as any;
  const partialLog: SessionEventBody[] = [daemonPrompt(PROMPT_A), ...live.filter((e: any) => e.ccUuid === toolUse.ccUuid)];
  const { emitted } = run(FIXTURE, partialLog);
  expect(emitted.filter((e: any) => e.ccUuid === toolUse.ccUuid)).toEqual([]); // never double-applied
  expect(emitted.some((e) => e.type === "tool.result")).toBe(true);
  expect(emitted.filter((e) => e.type === "message.user").length).toBe(2); // B + PTY, not A
});

test("missing transcript file is a clean no-op", () => {
  const { outcome } = run("/nonexistent/transcript.jsonl", []);
  expect(outcome).toEqual({ backfilled: 0, scanned: 0, warns: [] });
});

test("identical prompts consume the text multiset one-for-one", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-reconcile-"));
  const file = join(dir, "t.jsonl");
  const line = (uuid: string) => JSON.stringify({ type: "user", uuid, sessionId: "s", message: { role: "user", content: "hi" } });
  writeFileSync(file, `${line("u1")}\n${line("u2")}\n${line("u3")}\n`);
  // two daemon-logged "hi" prompts, three in the transcript → exactly one backfills
  const { emitted } = run(file, [daemonPrompt("hi"), daemonPrompt("hi")]);
  expect(emitted.length).toBe(1);
  expect((emitted[0] as any).rendered.source).toBe("hi");
  // and it keeps its uuid so the next run is a no-op
  const again = run(file, [daemonPrompt("hi"), daemonPrompt("hi"), ...emitted]);
  expect(again.emitted).toEqual([]);
});

test("legacy guard: uncorrelated assistant history blocks reconcile (pre-plan-6 logs)", () => {
  // A log written before ccUuid stamping: assistant content with no correlation at all.
  const legacyLog: SessionEventBody[] = [
    daemonPrompt(PROMPT_A),
    { type: "assistant.message", blocks: [] } as unknown as SessionEventBody,
  ];
  const { emitted, outcome } = run(FIXTURE, legacyLog);
  expect(emitted).toEqual([]);
  expect(outcome.backfilled).toBe(0);
  expect(outcome.warns.join(" ")).toContain("pre-plan-6");

  // …but a log whose only content is user prompts (turn died before any assistant event)
  // is safe to heal — nothing assistant-shaped to duplicate.
  const promptOnly = run(FIXTURE, [daemonPrompt(PROMPT_A)]);
  expect(promptOnly.outcome.backfilled).toBeGreaterThan(0);
});

test("meta/sidechain/CLI-internal lines never backfill", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-reconcile-"));
  const file = join(dir, "t.jsonl");
  const rows = [
    { type: "user", uuid: "m1", isMeta: true, message: { role: "user", content: "meta caveat" } },
    { type: "user", uuid: "s1", isSidechain: true, message: { role: "user", content: "sidechain" } },
    { type: "user", uuid: "c1", message: { role: "user", content: "<command-name>/exit</command-name>" } },
    { type: "user", uuid: "c2", message: { role: "user", content: "<local-command-stdout>Goodbye!</local-command-stdout>" } },
    { type: "user", uuid: "i1", message: { role: "user", content: "[Request interrupted by user]" } },
    { type: "user", uuid: "k1", message: { role: "user", content: "keep me" } },
    { type: "mode", mode: "normal" },
  ];
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const { emitted, outcome } = run(file, []);
  expect(emitted.length).toBe(1);
  expect((emitted[0] as any).rendered.source).toBe("keep me");
  expect(outcome.scanned).toBe(1);
});

test("a /clear boundary stops prior-topic prompts from absorbing the new topic's lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-reconcile-"));
  const file = join(dir, "t.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "user", uuid: "u-new", sessionId: "s2", message: { role: "user", content: "continue" } })}\n`);

  const boundary: SessionEventBody = {
    type: "assistant.message",
    blocks: [{ kind: "divider", label: "New topic", note: "…" }],
  } as unknown as SessionEventBody;

  // Same wording in the OLD topic, then /clear: the new transcript's "continue" must backfill.
  const { emitted } = run(file, [daemonPrompt("continue"), boundary]);
  expect(emitted.length).toBe(1);
  expect((emitted[0] as any).ccUuid).toBe("u-new");

  // Control: without the boundary the daemon-logged prompt legitimately absorbs it.
  const control = run(file, [daemonPrompt("continue")]);
  expect(control.emitted).toEqual([]);
});

test("AskUserQuestion answer echoes never backfill as tool-result cards (live-path parity)", () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-reconcile-"));
  const file = join(dir, "t.jsonl");
  const rows = [
    { type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [] } }] } },
    { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "chosen answers" }] } },
    { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "a REAL tool result" }] } },
  ];
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const { emitted } = run(file, []);
  // the question's tool_use is suppressed by the mapper and its echo by the reconciler;
  // the unrelated tool result still lands
  expect(emitted.map((e) => e.type)).toEqual(["tool.result"]);
  expect((emitted[0] as any).toolUseId).toBe("t9");
});
