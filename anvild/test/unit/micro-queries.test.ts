/**
 * The three CLI-direct micro-classifiers (cc plan 7 task 4) against the REAL fake-cc child:
 * branch-kind, the goal judge, and the icon picker share one no-tools single-turn shape
 * (cc/oneshot.ts runCcMicroQuery) and keep their upstream fallback semantics — heuristic for
 * branch-kind, throw-and-fail-open for the judge, undefined for the icon.
 */
import { test, expect } from "bun:test";
import { join } from "node:path";
import { classifyBranchKind, heuristicKind } from "../../src/agent/branch-kind";
import { judgeGoal } from "../../src/agent/goal";
import { pickIcon } from "../../src/agent/icon";

const FAKE_CC = join(import.meta.dir, "..", "helpers", "fake-cc.ts");
const FIX = (name: string) => join(import.meta.dir, "..", "fixtures", "oneshot", name);
const ENV = { PATH: process.env.PATH ?? "" };
const cc = (fixture: string, extra: Record<string, string> = {}) => ({
  ccCommand: ["bun", FAKE_CC],
  extraEnv: { FAKE_CC_FIXTURE: FIX(fixture), ...extra },
});

test("classifyBranchKind: model verdict wins; failure falls back to the heuristic", async () => {
  expect(await classifyBranchKind("please fix the crash", ENV, cc("micro-bugfix.ndjson"))).toBe("bugfix");
  // spawn failure → keyword heuristic (an urgent production fix reads as hotfix)
  const fallback = await classifyBranchKind("URGENT prod outage", ENV, {
    ccCommand: ["bun", FAKE_CC],
    extraEnv: { FAKE_CC_ERROR: "no cc" },
  });
  expect(fallback).toBe(heuristicKind("URGENT prod outage"));
  expect(fallback).toBe("hotfix");
});

test("judgeGoal: parses the verdict; a dead judge THROWS so the call site can fail open", async () => {
  const met = await judgeGoal("tests pass", "assistant: all green", ENV, cc("micro-met.ndjson"));
  expect(met).toEqual({ met: true, reason: "" });
  await expect(
    judgeGoal("tests pass", "t", ENV, { ccCommand: ["bun", FAKE_CC], extraEnv: { FAKE_CC_ERROR: "judge down" } }),
  ).rejects.toThrow();
});

test("pickIcon: constrained pick from the curated set; failure yields undefined", async () => {
  expect(await pickIcon("Fix the crash reporter", ENV, cc("micro-icon.ndjson"))).toBe("bug_report");
  expect(
    await pickIcon("x", ENV, { ccCommand: ["bun", FAKE_CC], extraEnv: { FAKE_CC_ERROR: "no cc" } }),
  ).toBeUndefined();
});
