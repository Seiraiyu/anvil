import { test, expect } from "bun:test";
import { shouldAutoApprove, spawnPaused, relayExhausted, MAX_TEAM_RELAY_HOPS } from "../../src/integrations/team-gate";

// `auto` joins `bypassPermissions` because D-6 made it the new-session default: gating on
// bypassPermissions alone would silently turn every lead's decomposition into an approval card.
// `dontAsk` deliberately does NOT auto-approve — its whole contract is that nothing unapproved runs.
test("the unattended modes auto-approve; everything else waits", () => {
  expect(shouldAutoApprove("bypassPermissions")).toBe(true);
  expect(shouldAutoApprove("auto")).toBe(true);
  expect(shouldAutoApprove("default")).toBe(false);
  expect(shouldAutoApprove("acceptEdits")).toBe(false);
  expect(shouldAutoApprove("plan")).toBe(false);
  expect(shouldAutoApprove("dontAsk")).toBe(false);
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
