import { test, expect } from "bun:test";
import { join } from "node:path";
import type { OpenRouterClient } from "../../src/integrations/openrouter";
import { planUnit } from "../../src/integrations/autopilot";

// planUnit rides the CLI-direct one-shot (cc/oneshot.ts) — no SDK mock, no global mock.module
// hazard: the spawn is pointed at the REAL fake-cc child, whose fixture replays an ExitPlanMode
// tool_use (the plan) and a result wrap-up, exactly like the recordings.
const FAKE_CC = join(import.meta.dir, "..", "helpers", "fake-cc.ts");
const PLAN_FIXTURE = join(import.meta.dir, "..", "fixtures", "cc", "oneshot-plan.ndjson");
const CANNED_PLAN = "# Plan\n\nChange src/x.ts to do the thing.";
const CC = { ccCommand: ["bun", FAKE_CC], extraEnv: { FAKE_CC_FIXTURE: PLAN_FIXTURE } };

// A `claude`-profile spawn requires a subscription token (agent/env.ts); fake placeholder.
process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";

const UNIT = { title: "Do the thing", rationale: "grouped", taskIds: ["t1"] };
const TASKS = [{ id: "t1", project_id: "p1", content: "the task" } as any];

// planUnit passes its repoRoot to the panel, so critics run in agentic mode (client.complete). This
// fake commits to a verdict immediately with no tool calls — the loop finishes in one turn.
function fakeClient(reply: string): OpenRouterClient {
  return {
    complete: async () => ({ content: reply, toolCalls: [] }),
    chat: async () => reply,
  } as unknown as OpenRouterClient;
}

test("planUnit is inert without the adversarial panel: no review, plan unchanged", async () => {
  const planned = await planUnit(UNIT, TASKS, { repoRoot: "/tmp", cc: CC });
  expect(planned.adversarial).toBeUndefined();
  expect(planned.plan).toBe(CANNED_PLAN);
  expect(planned.plan).not.toContain("## Adversarial Review");
});

test("planUnit runs the panel when enabled: review persisted + appended to the plan", async () => {
  const client = fakeClient(JSON.stringify({ score: 5, verdict: "meh", objections: ["a real gap"] }));
  const planned = await planUnit(UNIT, TASKS, {
    repoRoot: "/tmp",
    adversarial: { enabled: true, client, models: ["m1", "m2"] },
    cc: CC,
  });
  expect(planned.adversarial?.critiques).toHaveLength(2);
  expect(planned.plan).toContain("## Adversarial Review");
  expect(planned.plan).toContain("a real gap");
  // the original plan text is still present, ahead of the appended block
  expect(planned.plan.startsWith(CANNED_PLAN)).toBe(true);
});
