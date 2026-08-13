/**
 * QuestionBroker + normalizeQuestions (arch §6.6). The AskUserQuestion answer SHAPING (answers map
 * keyed by question text, annotations, cancel semantics) lives in the CLI transport's approve tool
 * and is pinned by test/unit/cc-permission-server.test.ts — the SDK-era makeCanUseTool died with
 * the driver (cc plan 7).
 */
import { test, expect } from "bun:test";
import { QuestionBroker, normalizeQuestions } from "../../src/agent/questions";

test("broker parks, resolves once, and reports the owning session", async () => {
  const broker = new QuestionBroker();
  const pending = broker.request("q_1", "sess_1");
  expect(broker.sessionFor("q_1")).toBe("sess_1");
  expect(broker.resolve("q_1", { cancelled: false, answers: [{ question: "Q?", labels: ["A"] }] })).toBe(true);
  expect(await pending).toEqual({ cancelled: false, answers: [{ question: "Q?", labels: ["A"] }] });
  // a second resolve is a no-op (already handed off)
  expect(broker.resolve("q_1", { cancelled: true })).toBe(false);
  expect(broker.sessionFor("q_1")).toBeUndefined();
});

test("resolveSession cancels every parked question for that session only", async () => {
  const broker = new QuestionBroker();
  const a = broker.request("q_a", "sess_1");
  const b = broker.request("q_b", "sess_1");
  const other = broker.request("q_c", "sess_2");
  expect(broker.resolveSession("sess_1")).toBe(2);
  expect(await a).toEqual({ cancelled: true });
  expect(await b).toEqual({ cancelled: true });
  expect(broker.sessionFor("q_c")).toBe("sess_2"); // untouched
  broker.resolve("q_c", { cancelled: true });
  await other;
});

test("normalizeQuestions coerces the opaque payload defensively", () => {
  expect(normalizeQuestions(undefined)).toEqual([]);
  expect(normalizeQuestions("nope")).toEqual([]);
  expect(normalizeQuestions([{ notAQuestion: true }, null])).toEqual([]);
  const qs = normalizeQuestions([
    {
      question: "Which library?",
      header: "Library",
      multiSelect: true,
      options: [{ label: "date-fns", description: "small", preview: "code" }, { label: 42 }],
    },
  ]);
  expect(qs).toEqual([
    {
      question: "Which library?",
      header: "Library",
      multiSelect: true,
      options: [
        { label: "date-fns", description: "small", preview: "code" },
        { label: "42", description: "" },
      ],
    },
  ]);
});
