// Replays the checked-in transcript-JSONL golden fixture (cc plan 6 Task 1, design §4.9)
// through the vendored transcript reader. Pins the facts the reconciler is built on:
//   1. CC's project-dir slug derivation matches projectSlug() (fixed decision: verify, don't assume)
//   2. stream-json stdout uuids == transcript line uuids (the dedupe key)
//   3. --resume APPENDS to the same transcript file — headless AND interactive TUI
//   4. TUI-only line types classify as non-message lines (skipped, never crash)
// Offline — fixtures are committed (test/tools/record-cc-transcript.ts re-records), CI-safe.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isMessageLine, parseTranscriptLine, projectSlug, readTranscript, transcriptPath, type TranscriptMessageLine } from "../../src/cc/transcript";
import { parseCCLine } from "../../src/cc/stream";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "cc-transcript");
const meta = JSON.parse(readFileSync(join(FIXTURES, "meta.json"), "utf8")) as {
  cwd: string;
  slug: string;
  sessionId: string;
  ptySessionId: string;
  magicWord: string;
  ptyMarker: string;
  lineCounts: { afterA: number; afterB: number; final: number };
};

function transcriptLines(name: string) {
  const { lines, warns } = readTranscript(join(FIXTURES, name));
  expect(warns).toEqual([]); // every committed line parses clean
  return lines;
}

function streamMessageUuids(name: string): string[] {
  const out: string[] = [];
  for (const raw of readFileSync(join(FIXTURES, name), "utf8").split("\n")) {
    const { msg } = parseCCLine(raw);
    if (msg && (msg.type === "assistant" || msg.type === "user") && typeof (msg as any).uuid === "string") {
      out.push((msg as any).uuid);
    }
  }
  return out;
}

test("fixtures exist (record with test/tools/record-cc-transcript.ts)", () => {
  expect(readdirSync(FIXTURES).sort()).toEqual([
    "meta.json",
    "transcript-after-a.jsonl",
    "transcript.jsonl",
    "turn-a.ndjson",
    "turn-b.ndjson",
  ]);
});

test("slug derivation matches what CC actually wrote (fixed decision)", () => {
  expect(projectSlug(meta.cwd)).toBe(meta.slug);
  expect(transcriptPath(meta.cwd, meta.sessionId, "/cfg")).toBe(`/cfg/projects/${meta.slug}/${meta.sessionId}.jsonl`);
});

test("stream-json uuids appear as transcript message-line uuids (the dedupe key)", () => {
  const transcript = new Set(transcriptLines("transcript.jsonl").filter(isMessageLine).map((l) => l.uuid));
  const stream = [...streamMessageUuids("turn-a.ndjson"), ...streamMessageUuids("turn-b.ndjson")];
  expect(stream.length).toBeGreaterThanOrEqual(6); // ≥2 user prompts' worth of assistant/tool traffic
  for (const uuid of stream) expect(transcript.has(uuid)).toBe(true);
});

test("headless --resume appended to the same file (after-A is a message-uuid prefix of final)", () => {
  const afterA = transcriptLines("transcript-after-a.jsonl").filter(isMessageLine).map((l) => l.uuid);
  const final = transcriptLines("transcript.jsonl").filter(isMessageLine).map((l) => l.uuid);
  expect(final.length).toBeGreaterThan(afterA.length);
  expect(final.slice(0, afterA.length)).toEqual(afterA);
});

test("interactive TUI --resume kept the same session file (the attach-flow assumption)", () => {
  expect(meta.ptySessionId).toBe(meta.sessionId);
  const msgs = transcriptLines("transcript.jsonl").filter(isMessageLine);
  // every message line belongs to the one session
  for (const m of msgs) expect(m.sessionId).toBe(meta.sessionId);
  // the PTY-typed turn is in the file: marker prompt, then an assistant reply echoing it
  const idx = msgs.findIndex((m) => m.type === "user" && !m.isMeta && JSON.stringify(m.message.content).includes(meta.ptyMarker));
  expect(idx).toBeGreaterThanOrEqual(0);
  // …and a later assistant TEXT block echoes it (the first assistant line may be thinking-only)
  const reply = msgs
    .slice(idx + 1)
    .find((m) => m.type === "assistant" && JSON.stringify(m.message.content).includes(meta.ptyMarker));
  expect(reply).toBeDefined();
});

test("message lines carry uuid + API-shaped message; assistant content is a block array", () => {
  const msgs = transcriptLines("transcript.jsonl").filter(isMessageLine);
  expect(msgs.length).toBeGreaterThanOrEqual(10);
  for (const m of msgs) {
    expect(typeof m.uuid).toBe("string");
    expect(m.uuid.length).toBeGreaterThan(0);
  }
  for (const a of msgs.filter((m) => m.type === "assistant")) {
    expect(Array.isArray(a.message.content)).toBe(true);
  }
  // the headless tool turn's tool_use → tool_result pair is present (uuid-mapped by the reconciler)
  const hasToolUse = msgs.some(
    (m) => m.type === "assistant" && (m.message.content as any[]).some((b) => b?.type === "tool_use" && b.name === "Read"),
  );
  const hasToolResult = msgs.some(
    (m) => m.type === "user" && Array.isArray(m.message.content) && (m.message.content as any[]).some((b) => b?.type === "tool_result"),
  );
  expect(hasToolUse).toBe(true);
  expect(hasToolResult).toBe(true);
});

test("TUI bookkeeping line types classify as non-message lines (skipped, never crash)", () => {
  const lines = transcriptLines("transcript.jsonl");
  const other = new Set(lines.filter((l) => !isMessageLine(l)).map((l) => l.type));
  // The TUI-only shapes the recording captured — a reconciler must skip all of them.
  for (const t of ["queue-operation", "attachment", "ai-title", "last-prompt", "mode", "file-history-snapshot", "permission-mode", "system"]) {
    expect(other.has(t)).toBe(true);
  }
  expect(other.has("user")).toBe(false);
  expect(other.has("assistant")).toBe(false);
});

test("the /exit command echo rides NON-meta user lines (reconciler must filter by content tag too)", () => {
  // Pinned because it is surprising: `<command-name>/exit` and `<local-command-stdout>` arrive as
  // ordinary user lines with isMeta ABSENT — isMeta alone does not identify CLI-internal traffic.
  const msgs = transcriptLines("transcript.jsonl").filter(isMessageLine);
  const cmdLines = msgs.filter((m) => m.type === "user" && typeof m.message.content === "string" && /^<(command-name|local-command-stdout)/.test(m.message.content as string));
  expect(cmdLines.length).toBeGreaterThanOrEqual(2);
  expect(cmdLines.every((m) => !m.isMeta)).toBe(true);
});

test("parseTranscriptLine tolerates garbage without throwing", () => {
  expect(parseTranscriptLine("")).toEqual({});
  expect(parseTranscriptLine("not json").warn).toContain("unparseable");
  expect(parseTranscriptLine("[1,2]").warn).toContain("non-object");
  expect(parseTranscriptLine('{"noType":1}').warn).toContain("without string `type`");
  const torn = parseTranscriptLine('{"type":"assistant","uuid":"x","message":{"content"');
  expect(torn.warn).toContain("unparseable");
});

// keeps the fixture honest about what a *message* line is
const _typecheck: TranscriptMessageLine | undefined = undefined;
void _typecheck;
