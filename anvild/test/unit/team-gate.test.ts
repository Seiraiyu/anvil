import { test, expect } from "bun:test";
import { shouldAutoApprove, spawnPaused, relayExhausted, MAX_TEAM_RELAY_HOPS } from "../../src/integrations/team-gate";

test("bypassPermissions auto-approves; everything else waits", () => {
  expect(shouldAutoApprove("bypassPermissions")).toBe(true);
  expect(shouldAutoApprove("default")).toBe(false);
  expect(shouldAutoApprove("acceptEdits")).toBe(false);
  expect(shouldAutoApprove("plan")).toBe(false);
});

test("member spawns pause only while the budget is in its warn zone", () => {
  expect(spawnPaused({ warn: true })).toBe(true);
  expect(spawnPaused({ warn: false })).toBe(false);
  expect(spawnPaused({})).toBe(false);
});

test("relayExhausted trips only past the hop cap (lead↔member loop guard)", () => {
  expect(relayExhausted(1)).toBe(false);
  expect(relayExhausted(MAX_TEAM_RELAY_HOPS)).toBe(false);
  expect(relayExhausted(MAX_TEAM_RELAY_HOPS + 1)).toBe(true);
});
