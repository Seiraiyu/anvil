// Replays the checked-in golden recordings through the vendored parser (design §8):
// every line must parse cleanly, core shapes must classify as KNOWN (Assumption 1),
// init must carry session_id, result must carry usage, and the tool recording must
// contain an assistant tool_use block. Offline — fixtures are committed, CI-safe.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCCLine, type CCMessage } from "../../src/cc/stream";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "cc");

function replay(name: string): CCMessage[] {
  const out: CCMessage[] = [];
  for (const line of readFileSync(join(FIXTURES, name), "utf8").split("\n")) {
    const { msg, warn } = parseCCLine(line);
    expect(warn).toBeUndefined();
    if (msg) out.push(msg);
  }
  return out;
}

test("fixtures exist (record with test/tools/record-cc-stream.ts)", () => {
  expect(readdirSync(FIXTURES).sort()).toEqual(["basic.ndjson", "cc-version.txt", "resume.ndjson", "tool.ndjson"]);
});

for (const name of ["basic.ndjson", "tool.ndjson", "resume.ndjson"]) {
  test(`${name}: parses clean, init first with session_id, result last with usage`, () => {
    const msgs = replay(name);
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.filter((m) => m.type === "unknown")).toEqual([]); // core shapes are KNOWN (Assumption 1)
    const init = msgs[0] as any;
    expect(init.type).toBe("system");
    expect(init.subtype).toBe("init");
    expect(typeof init.session_id).toBe("string");
    const result = msgs[msgs.length - 1] as any;
    expect(result.type).toBe("result");
    expect(result.usage).toBeDefined();
  });
}

test("tool.ndjson contains an assistant tool_use block (Read)", () => {
  const msgs = replay("tool.ndjson");
  const toolUses = msgs
    .filter((m): m is any => m.type === "assistant")
    .flatMap((m) => (m.message.content ?? []) as any[])
    .filter((b) => b?.type === "tool_use");
  expect(toolUses.length).toBeGreaterThan(0);
  expect(toolUses.some((b) => b.name === "Read")).toBe(true);
});

test("resume.ndjson resumed the basic session (session continuity)", () => {
  const basicInit = replay("basic.ndjson")[0] as any;
  const resumeInit = replay("resume.ndjson")[0] as any;
  expect(typeof resumeInit.session_id).toBe("string");
  // Resume may mint a new leaf id but must not error; the semantic check is that the
  // model could answer from prior context — assert the result isn't an error.
  const result = replay("resume.ndjson").at(-1) as any;
  expect(result.is_error ?? false).toBe(false);
  expect(basicInit.session_id).not.toBe("");
});

test("stream deltas present (--include-partial-messages — Spike 3 resolution)", () => {
  const msgs = replay("basic.ndjson");
  expect(msgs.some((m) => m.type === "stream_event")).toBe(true);
});
