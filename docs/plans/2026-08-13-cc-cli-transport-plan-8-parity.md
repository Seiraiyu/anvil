# CC CLI Transport — Plan 8: Full-parity sweep + flag flip

**Goal:** Every upstream feature exercised green on CLI-direct; `ANVIL_CC_DIRECT` flag removed; CLI-direct is the only path.
**Architecture:** Design §5 phase 8. This is a verification-heavy phase: most code landed in Plans 3–7; what remains is the long tail of features that ride the driver surface.

**GATES:** Plans 3–7 merged.

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Parity checklist doc generated from upstream feature surface (teams, loops, goals, attachments, file offers, deliverables, CLAUDE.md reflection, new-topic, account rebind, budget gauge, push flows) | pending | no | no |
| 2 | Walk the checklist on a live daemon; file + fix gaps (each gap = its own commit with a test) | pending | no | no |
| 3 | Fleet: multi-daemon with mixed versions — `cc-update` capability gating verified against an older daemon | pending | no | no |
| 4 | ~~Remove the flag + the SDK-path branches in supervisor; delete dead driver tests superseded by turn-runner tests~~ **Pulled forward into Plan 7 task 6** (SDK deletion forces it — decision 2026-08-13; see plan 7's execution amendments). Remaining here: verify no regression from the flip during the task-2 live walk. | pending | no | no |
| 5 | Full CI + existing integration suites green; goldens regenerated once, reviewed | pending | no | no |

Known parity hot-spots to check explicitly (from the seam map — each has driver coupling):
- `driver.ts` responsibilities beyond the query loop that must have found new homes: AskUserQuestion answer-echo suppression (`askQuestionIds`), file-offer/deliverable realization (`pendingOffers` → `buildFileOffer`/`maybeTaildrop`), turn dividers with token counts (`fmtTokens`), CLAUDE.md-reflection prompts (`supervisor.ts:1215`), daemon-initiated turns (`:1344`), team member drain on turn end (`onAgentResult` → `teams.drainQueuedMembers()`).
- `team-coordinator.ts:50,137` comments still reference "the member's InputQueue" — update comments to the queue-in-supervisor reality.
- Offline outbox migration from Plan 4 Task 6 verified against a client that queued commands pre-upgrade.
- `supervisor.planReviewer` (interactive adversarial plan review) lost its caller with the SDK driver (plan 7) — rewire onto the CC `ExitPlanMode` flow (the approve tool sees `input.plan`) or decide to drop the feature.

**Phase acceptance (design §5.8):** all upstream-parity features exercised in the fork's suites; the flag and SDK path are gone.
