import { test, expect } from "bun:test";
import type { CCMessage } from "../../src/cc/stream";
import { mapMessage, extractSessionId, extractResultUsage, askUserQuestionToolIds } from "../../src/agent/map";
import { PassthroughRenderer } from "../../src/render/markdown";

const r = new PassthroughRenderer();
const map = (m: unknown) => mapMessage(m as CCMessage, r);

test("stream_event text_delta → assistant.delta", () => {
  const out = map({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "PO" } } });
  expect(out).toEqual([{ type: "assistant.delta", text: "PO" }]);
});

test("non-text stream_event → nothing", () => {
  expect(map({ type: "stream_event", event: { type: "message_start" } })).toEqual([]);
});

test("assistant text → assistant.message with one markdown block", () => {
  const out = map({ type: "assistant", message: { content: [{ type: "text", text: "hello **world**" }] } });
  expect(out).toHaveLength(1);
  expect(out[0]!.type).toBe("assistant.message");
  const blocks = (out[0] as any).blocks;
  expect(blocks[0].kind).toBe("markdown");
  expect(blocks[0].rendered.source).toBe("hello **world**");
});

test("assistant tool_use → assistant.message block + a tool.use event", () => {
  const out = map({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }] },
  });
  expect(out.map((e) => e.type)).toEqual(["assistant.message", "tool.use"]);
  expect((out[1] as any).toolUseId).toBe("tu_1");
  expect((out[1] as any).name).toBe("Bash");
});

test("AskUserQuestion tool_use is suppressed (rendered as a question card, not a tool block)", () => {
  const m = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu_q", name: "AskUserQuestion", input: { questions: [] } }] },
  };
  // No assistant.message (blocks would be empty) and no tool.use event for the question.
  expect(map(m)).toEqual([]);
  expect(askUserQuestionToolIds(m as unknown as CCMessage)).toEqual(["tu_q"]);
});

test("AskUserQuestion alongside text keeps the text block but drops the question tool_use", () => {
  const out = map({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "let me ask" },
        { type: "tool_use", id: "tu_q", name: "AskUserQuestion", input: { questions: [] } },
        { type: "tool_use", id: "tu_b", name: "Bash", input: { command: "ls" } },
      ],
    },
  });
  expect(out.map((e) => e.type)).toEqual(["assistant.message", "tool.use"]);
  expect((out[0] as any).blocks.map((b: any) => b.kind)).toEqual(["markdown", "tool_use"]);
  expect((out[1] as any).name).toBe("Bash"); // only the non-question tool.use is emitted
});

test("user tool_result → tool.result (string + array content)", () => {
  const s = map({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }] } });
  expect(s).toEqual([{ type: "tool.result", toolUseId: "tu_1", content: "ok", isError: false }]);
  const a = map({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: [{ type: "text", text: "li" }, { type: "text", text: "ne" }], is_error: true }] } });
  expect(a).toEqual([{ type: "tool.result", toolUseId: "tu_2", content: "line", isError: true }]);
});

test("result → result event + usage extraction", () => {
  const m = { type: "result", subtype: "success", stop_reason: "end_turn", num_turns: 2, usage: { input_tokens: 11, output_tokens: 22 } };
  const out = map(m);
  expect(out[0]).toEqual({ type: "result", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 22, turns: 2 } });
  expect(extractResultUsage(m as unknown as CCMessage)).toEqual({ inputTokens: 11, outputTokens: 22, turns: 2 });
});

test("extractSessionId pulls session_id when present", () => {
  expect(extractSessionId({ type: "system", session_id: "abc" } as unknown as CCMessage)).toBe("abc");
  expect(extractSessionId({ type: "system" } as unknown as CCMessage)).toBeUndefined();
});

// ── CC-transport fallback classification (plan 3 task 4, design §4.7 delta 3) ──────────────
// Unknown CC output is never dropped: an unknown TOP-LEVEL type (parser's {type:"unknown"})
// and an unknown CONTENT-BLOCK type inside an assistant message both become a fallback card,
// with the raw payload as size-capped pretty JSON. Known-ignored block types stay silent.
import { FALLBACK_JSON_CAP } from "../../src/agent/map";

test("unknown top-level message → one fallback card", () => {
  const out = map({ type: "unknown", ccType: "shiny_new_thing", raw: { type: "shiny_new_thing", x: 1 } });
  expect(out).toHaveLength(1);
  expect(out[0]!.type).toBe("assistant.message");
  const b = (out[0] as any).blocks[0];
  expect(b.kind).toBe("fallback");
  expect(b.ccType).toBe("shiny_new_thing");
  expect(JSON.parse(b.json)).toEqual({ type: "shiny_new_thing", x: 1 });
});

test("unknown assistant content-block type → fallback block beside known blocks", () => {
  const out = map({
    type: "assistant",
    message: { content: [{ type: "text", text: "hi" }, { type: "mystery_block", payload: { deep: true } }] },
  });
  const blocks = (out[0] as any).blocks;
  expect(blocks.map((b: any) => b.kind)).toEqual(["markdown", "fallback"]);
  expect(blocks[1].ccType).toBe("mystery_block");
  expect(JSON.parse(blocks[1].json)).toEqual({ type: "mystery_block", payload: { deep: true } });
});

test("thinking blocks stay silent (known-ignored, not a fallback card)", () => {
  const out = map({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: "hmm", signature: "sig" }] },
  });
  expect(out).toEqual([]);
});

test("fallback JSON is size-capped", () => {
  const out = map({ type: "unknown", ccType: "big", raw: { blob: "x".repeat(FALLBACK_JSON_CAP * 2) } });
  const b = (out[0] as any).blocks[0];
  expect(b.json.length).toBeLessThanOrEqual(FALLBACK_JSON_CAP + 100); // cap + truncation marker
  expect(b.json).toContain("truncated");
});

test("rate_limit_event maps to nothing (known, gauge-only)", () => {
  expect(map({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })).toEqual([]);
});
