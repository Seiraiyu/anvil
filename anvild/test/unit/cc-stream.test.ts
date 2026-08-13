// Guards design §4.2/§4.7-delta-3: the vendored stream-json parser never drops a line —
// known types pass through, unknown types are preserved as {type:"unknown"}, garbage
// becomes a warn, and blank lines are ignored. Pinned offline; golden replay is Task 7.
import { expect, test } from "bun:test";
import { parseCCLine, MAX_LINE_BYTES, NdjsonSplitter } from "../../src/cc/stream";

test("known message types pass through typed", () => {
  const { msg, warn } = parseCCLine('{"type":"system","subtype":"init","session_id":"abc"}');
  expect(warn).toBeUndefined();
  expect(msg?.type).toBe("system");
  expect((msg as any).session_id).toBe("abc");
});

test("rate_limit_event is KNOWN (present in every cc 2.1.231 recording)", () => {
  const { msg, warn } = parseCCLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}');
  expect(warn).toBeUndefined();
  expect(msg?.type).toBe("rate_limit_event");
  expect((msg as any).rate_limit_info.status).toBe("allowed");
});

test("unknown type is preserved, not dropped", () => {
  const { msg } = parseCCLine('{"type":"totally_new_thing","payload":{"x":1}}');
  expect(msg?.type).toBe("unknown");
  expect((msg as any).ccType).toBe("totally_new_thing");
  expect((msg as any).raw.payload).toEqual({ x: 1 });
});

test("garbage line yields warn, no throw", () => {
  const { msg, warn } = parseCCLine("{not json");
  expect(msg).toBeUndefined();
  expect(warn).toContain("unparseable");
});

test("non-object and missing-type lines yield warn", () => {
  expect(parseCCLine("[1,2]").warn).toContain("skipped");
  expect(parseCCLine('{"no_type":true}').warn).toContain("skipped");
});

test("blank line is ignored (no msg, no warn)", () => {
  expect(parseCCLine("  \n")).toEqual({});
});

test("splitter reassembles lines across chunk boundaries", () => {
  const s = new NdjsonSplitter();
  expect(s.push('{"type":"sys')).toEqual([]);
  expect(s.push('tem","subtype":"init"}\n{"type":"result"}\n{"ty')).toEqual([
    '{"type":"system","subtype":"init"}',
    '{"type":"result"}',
  ]);
  expect(s.flush()).toBe('{"ty');
});

test("splitter flush on empty buffer returns undefined", () => {
  expect(new NdjsonSplitter().flush()).toBeUndefined();
});

test("oversized line is skipped with warn", () => {
  const big = `{"type":"assistant","message":{"content":[{"type":"text","text":"${"x".repeat(MAX_LINE_BYTES)}"}]}}`;
  const { msg, warn } = parseCCLine(big);
  expect(msg).toBeUndefined();
  expect(warn).toContain("exceeds");
});
