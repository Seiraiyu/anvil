# CC CLI Transport — Plan 8 parity checklist (task 1)

Generated 2026-08-13 from the upstream feature surface. Verification key:
**suite** = covered by the offline test suite; **live** = exercised on a real daemon during the
plan-8 walk (2026-08-13, daemon `4.0.0+e683423` on `127.0.0.1:7799`, real state dir, real
subscription token, haiku/sonnet); **manual** = needs a physical device or an external service;
**blocked** = cannot run on this machine until a listed prerequisite is provided.

## Upstream feature surface

| Feature | How verified | Result / notes |
|---------|--------------|----------------|
| Interactive turn (prompt → deltas → result) | live + suite (`cc-turn-runner`, `cc-stream`) | ✅ PONG turn, usage `{in:10, out:48, turns:1}` streamed CLI-direct |
| Teams (lead/member spawn, relay, drain, integrate) | suite (`team-coordinator`, `team-tools`, `team-plan`, `team-gate`, `team-integrate`, `team-tree`) | ✅ offline; member drain live home verified (`supervisor.onAgentResult` → `drainQueuedMembers`, supervisor.ts:2155 + kill:1809). Live team spawn not walked (cost); no driver coupling remains |
| Loops | suite (`loops`, `autopilot-plan-loops`) | ✅ offline; `loops.snapshot` flowed on live hello |
| Goals (arm, judge, stop-hook) | suite (`goal`, `goal-push`) | ✅ offline; goal Stop hook rides the per-spawn settings overlay (`ensureDriver` → `writeSettingsOverlay(id, {goalStopHook:true})`); `judgeGoal` micro-query live-verified via `runCcMicroQuery` (returned exact word) |
| Attachments (upload → inline into turn) | **live** + suite (`attachments`, `attach-store`, `cc-attach`) | ✅ REST upload + `prompt.send attachmentIds` → model read the attached content back |
| File offers / deliverables | **live** + suite | ✅ Write of `numbers.csv` → `file.offer` emitted (taildrop best-effort false off-tailnet). Note: offers key off `DELIVERABLE_EXTS` (file-offer.ts) — `.html`/source files intentionally don't offer |
| CLAUDE.md reflection | suite (`claude-md-reflection`) | ✅ offline; new home verified: `supervisor.ts:1221-1226` (`reflectedSessions` + daemon-initiated `ensureDriver(id).prompt(CLAUDE_MD_REFLECTION_PROMPT)`) |
| New-topic (fresh context, keep scrollback) | **live** | ✅ `session.new_topic` → next turn completed `end_turn` on a fresh CC context |
| Account rebind (idle session, multi-account §5.3) | **live** + suite (`session-account-set`, `session-account-binding`) | ✅ idle rebind personal↔work: `session.updated` + "Switched to" message both ways, no turn billed |
| Budget gauge | live + suite (`budget`) | ✅ `budget` event on hello; per-turn `usage` + context meter (`onAgentResult` → `contextUsage`) |
| Push flows (FCM/APNs/webpush "your turn", goal pushes) | suite (`push-perms`, `goal-push`) + **manual** | offline-covered; end-to-end delivery needs a real device — not walkable headless |
| Permission prompts (incl. AskUserQuestion) | **live** + suite (`cc-permission-server`, `interrupt-awaiting-permission`) | ✅ ExitPlanMode arrived as `permission.request` via the MCP approve tool; deny wound the turn down cleanly |
| Adversarial plan review (ExitPlanMode) | suite + live-adjacent | ✅ rewired this phase: `planProposed` hook on `CcPermissionDeps`, awaited before the card (cc-permission-server.test.ts). Live: flow healthy with hook in place (self-gates without an OpenRouter key) |
| Turn dividers / token counts (`fmtTokens`) | suite (`cc-turn-runner`) | ✅ new home `turn-runner.ts:108,288` (compact-boundary divider with pre→post tokens) |
| AskUserQuestion answer-echo suppression | suite | ✅ new home `turn-runner.ts:327` (`askQuestionIds` skip of the echoed tool_result) |
| Daemon-initiated turns (/compact-style, reflection) | suite | ✅ `supervisor.ts:1216` — the driver.prompt path with no user message |
| Oneshot planning brain (`runCcQuery` readonly) | **live** | ✅ plan-mode run captured a 946-char `ExitPlanMode` plan; guard overlay let the headless run terminate. Caveat (expected): a model that answers in prose without calling ExitPlanMode yields `plan=undefined` — the pipeline's wrap-up-text fallback (`phases.ts:70`) covers it |
| Oneshot write phase (pipeline P3 shape) | **live** | ✅ write-mode `runCcQuery` created the file with guard hook installed |
| Micro-classifiers (`branch-kind`, `judgeGoal`, `pickIcon`) | **live** + suite (`cc-oneshot`) | ✅ `runCcMicroQuery` exact-word reply on the real CLI (`--tools ""` single-turn form) |
| Offline outbox migration (plan 4 task 6) | suite | see hot-spot table below |
| Fleet `cc-update` capability gating | suite | see hot-spot table below |

## Flag-flip regression (plan 8 task 4 residue)

The `ANVIL_CC_DIRECT` flag + SDK path were removed in plan 7 (pulled forward). The live walk above
ran **entirely CLI-direct on the flipped code** — session create, turns, permissions, attachments,
offers, rebind, new-topic all healthy on a real daemon. **No regression observed.**

## §5.7 carried-forward live acceptance (from plan 7)

| Item | Status |
|------|--------|
| Autopilot planning + pipeline phase seams CLI-direct, live | ✅ done via `runCcQuery` (readonly + write) and `runCcMicroQuery` on the real CLI — the exact seams `planUnit`/`bundleTasks`/`defaultAgent` ride |
| `autopilot.run` end-to-end (Todoist wrapper) | ⛔ blocked: Todoist is not connected on this daemon (`runAutopilot` hard-requires an access token) |
| `runDevPipeline` end-to-end | ⛔ blocked: requires `OPENROUTER_API_KEY` by design (dual-model GLM phases) |
| GLM env profile spawn | ⛔ blocked: no `OPENROUTER_API_KEY` in `~/.config/anvil/env`. The profile is env-only (`ANTHROPIC_BASE_URL` + key, `agent/env.ts`), spawn-contract covered offline by fake-cc; needs a key to run live |

## Parity hot-spots (from the plan-8 seam map)

| Hot-spot | Verdict |
|----------|---------|
| `askQuestionIds` echo suppression | ✅ relocated (`cc/turn-runner.ts:327`) |
| `pendingOffers` → `buildFileOffer`/`maybeTaildrop` | ✅ relocated (`cc/turn-runner.ts:123,331,401`) + live-verified |
| `fmtTokens` dividers | ✅ relocated (`cc/turn-runner.ts:108,288`) |
| CLAUDE.md reflection prompts | ✅ relocated (`supervisor.ts:1221-1226`) |
| Daemon-initiated turns | ✅ relocated (`supervisor.ts:1216` area) |
| Team drain on turn end | ✅ relocated (`supervisor.ts:2155`, kill path `:1809`) |
| `team-coordinator.ts` stale InputQueue comments | ✅ fixed this phase |
| `supervisor.planReviewer` uncalled | ✅ rewired onto the CC ExitPlanMode flow this phase (decision: rewire, not drop — feature intact and toggle-gated) |
| Offline outbox migration (plan 4 task 6) | ✅ migration lives in `web/src/outbox.ts:81` (applied on load); was UNTESTED — pre-upgrade-client tests added this phase (`test/web/outbox.test.ts`: legacy `session.create` rewrite, `session.set_autonomy` → `set_permission_mode`, unknown-policy fallback, modern pass-through) |
| `cc-update` gating vs older daemon (plan 8 task 3) | ✅ client-side: `ccCardRowHtml` renders nothing without the capability (`web/src/fleet.ts:927`) and `wireCcUpdate` no-ops when the row is absent; `test/web/cc-update-card.test.ts:62-63` pins the two older-daemon shapes (no `capabilities`; capabilities without `cc-update`). Native shells carry no direct `/api/cc/v1` refs (they bundle the gated web UI). A live two-daemon mixed-version pairing was not run (needs a second machine on the tailnet); the capability list is additive-only (`server/identity.ts`) and the update API contract is pinned by `cc-api-contract.test.ts` |
