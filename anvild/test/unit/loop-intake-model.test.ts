/**
 * Codebase-grounded model intake (loops-circuit FU-1, extended). Proves the JSON parse/validation is
 * strict, the run is driven through the CLI-direct one-shot against the REAL fake-CC child (no
 * subprocess mocks — the cc-cli-transport convention), each tool the agent uses streams through
 * `onStep`, and every malformed reply throws so the LoopService caller falls back to the heuristic.
 * In plan mode the agent answers via ExitPlanMode (captured as `plan`); we parse that.
 */
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelIntake, parseOverlay } from "../../src/loops/intake-model";
import type { ModelSpec } from "../../src/agent/model-roster";

const FAKE_CC = join(import.meta.dir, "..", "helpers", "fake-cc.ts");

// The one-shot builds the agent env (which requires a Claude token) before it ever spawns, so give it a
// dummy — the child is fake-cc, and in production a missing token just makes modelIntake throw and the
// caller falls back to the heuristic.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= "test-token";

const ctx = { prompt: "Add CSV export to reports", isFeature: true, testScript: "bun test" };
const SONNET: ModelSpec = { id: "claude", profile: "claude", sdkModel: "sonnet", label: "Claude Sonnet" };

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "loop-intake-"));
  tmpDirs.push(d);
  return d;
}

type Step = { name: string; input?: Record<string, unknown> };

/** Write an ndjson fixture and return the fake-cc seam that replays it. */
function seam(lines: unknown[]): { ccCommand: string[]; extraEnv: Record<string, string> } {
  const file = join(scratch(), "fixture.ndjson");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { ccCommand: ["bun", FAKE_CC], extraEnv: { FAKE_CC_FIXTURE: file } };
}

const toolUse = (steps: Step[]) => ({
  type: "assistant",
  message: { role: "assistant", content: steps.map((s, i) => ({ type: "tool_use", id: `tu_${i}`, name: s.name, input: s.input ?? {} })) },
});

/** A scripted agent that delivers `reply` as the final result. */
function scripted(reply: string, steps: Step[] = []) {
  return seam([
    ...(steps.length ? [toolUse(steps)] : []),
    { type: "result", subtype: "success", is_error: false, result: reply },
  ]);
}

/** A scripted agent that answers via ExitPlanMode (the plan-mode shape the real intake uses). */
function scriptedPlan(plan: string, steps: Step[] = []) {
  return seam([
    ...(steps.length ? [toolUse(steps)] : []),
    toolUse([{ name: "ExitPlanMode", input: { plan } }]),
    { type: "result", subtype: "success", is_error: false, result: "" },
  ]);
}

test("parseOverlay accepts a well-formed object and caps the rung at pr", () => {
  const o = parseOverlay(
    `{"name":"CSV export","checkCommand":"bun test export","checkLocks":["test/export.test.ts"],"scopeAllow":["src/reports/"],"assumptions":["comma delimiter"],"rung":"ship"}`,
    ctx,
  );
  expect(o.name).toBe("CSV export");
  expect(o.checkCommand).toBe("bun test export");
  expect(o.checkLocks).toEqual(["test/export.test.ts"]);
  expect(o.scopeAllow).toEqual(["src/reports/"]);
  expect(o.assumptions).toEqual(["comma delimiter"]);
  expect(o.rung).toBeUndefined(); // "ship" is refused — a new loop can't be trusted into auto-merge
});

test("parseOverlay pulls JSON out of surrounding prose/fences", () => {
  const o = parseOverlay("Sure! Here you go:\n```json\n{\"checkCommand\":\"bun test\"}\n```\nHope that helps", ctx);
  expect(o.checkCommand).toBe("bun test");
});

test("parseOverlay throws on no JSON, on invalid JSON, and on an all-empty object", () => {
  expect(() => parseOverlay("no json here", ctx)).toThrow();
  expect(() => parseOverlay("{not valid json}", ctx)).toThrow();
  expect(() => parseOverlay("{}", ctx)).toThrow(/no usable fields/);
  // An object with only junk/blank fields is also unusable.
  expect(() => parseOverlay(`{"name":"   ","checkLocks":[]}`, ctx)).toThrow();
});

test("modelIntake drives the one-shot and returns the parsed overlay", async () => {
  const overlay = await modelIntake(ctx, { model: SONNET, cc: scripted(`{"checkCommand":"bun test export","rung":"draft"}`) });
  expect(overlay.checkCommand).toBe("bun test export");
  expect(overlay.rung).toBe("draft");
});

test("modelIntake reads the repo, streams each step via onStep, and parses the overlay from the plan", async () => {
  const seen: { tool: string; detail: string }[] = [];
  const repoRoot = scratch();
  const cc = scriptedPlan(`{"checkCommand":"bun test export","scopeAllow":["src/reports/"]}`, [
    { name: "Read", input: { file_path: `${repoRoot}/CLAUDE.md` } },
    { name: "Grep", input: { pattern: "export" } },
  ]);
  const overlay = await modelIntake({ prompt: "Add export", isFeature: true, repoRoot }, { model: SONNET, onStep: (s) => seen.push(s), cc });
  expect(overlay.checkCommand).toBe("bun test export"); // parsed from the ExitPlanMode plan
  expect(overlay.scopeAllow).toEqual(["src/reports/"]);
  expect(seen.map((s) => s.tool)).toEqual(["Read", "Grep"]);
  expect(seen[0]?.detail).toBe(`${repoRoot}/CLAUDE.md`); // ExitPlanMode itself is not reported as a step
});

test("modelIntake throws on a garbage reply (caller falls back to the heuristic)", async () => {
  await expect(modelIntake(ctx, { model: SONNET, cc: scripted("I couldn't do that") })).rejects.toThrow();
});
