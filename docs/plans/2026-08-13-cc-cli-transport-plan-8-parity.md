# CC CLI Transport — Plan 8: Full-parity sweep + flag flip

**Goal:** Every upstream feature exercised green on CLI-direct; `ANVIL_CC_DIRECT` flag removed; CLI-direct is the only path.
**Architecture:** Design §5 phase 8. This is a verification-heavy phase: most code landed in Plans 3–7; what remains is the long tail of features that ride the driver surface.

**GATES:** Plans 3–7 merged.

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Parity checklist doc generated from upstream feature surface (teams, loops, goals, attachments, file offers, deliverables, CLAUDE.md reflection, new-topic, account rebind, budget gauge, push flows) | done | yes | yes |
| 2 | Walk the checklist on a live daemon; file + fix gaps (each gap = its own commit with a test) | done | yes | yes |
| 3 | Fleet: multi-daemon with mixed versions — `cc-update` capability gating verified against an older daemon | done (suite-verified; see notes) | yes | yes |
| 4 | ~~Remove the flag + the SDK-path branches in supervisor; delete dead driver tests superseded by turn-runner tests~~ **Pulled forward into Plan 7 task 6** (SDK deletion forces it — decision 2026-08-13; see plan 7's execution amendments). Remaining here: verify no regression from the flip during the task-2 live walk. | done | yes | yes |
| 5 | Full CI + existing integration suites green; goldens regenerated once, reviewed | done | yes | yes |

**Execution notes (2026-08-13):** results recorded per-item in
[`2026-08-13-cc-cli-transport-plan-8-parity-checklist.md`](2026-08-13-cc-cli-transport-plan-8-parity-checklist.md).
Highlights:
- **Live walk (task 2)** ran on a real daemon (`bun src/main.ts`, real state dir + roster, port 7799):
  interactive turn, file offer (`.csv` deliverable), attachment inline, new-topic, idle account
  rebind both ways, and plan-mode `ExitPlanMode` through the MCP approve tool — all green
  CLI-direct. One walk false-alarm: `.html` is deliberately not a deliverable ext, offers fire on
  `DELIVERABLE_EXTS` only.
- **planReviewer rewired, not dropped**: `CcPermissionDeps.planProposed`, awaited with `input.plan`
  before the approval card (and before the `allow_always` shortcut); throw-proofed; unit-pinned in
  `cc-permission-server.test.ts`.
- **Gap fixed (task 2 rule: gap = commit + test)**: the plan-4 task-6 outbox migration was
  untested — pre-upgrade-client tests added (`test/web/outbox.test.ts`).
- **Task 3** verified at the contract level: capability-gated render (`ccCardRowHtml` → "" without
  `cc-update`, pinned by `cc-update-card.test.ts` for both older-daemon shapes); a live two-daemon
  mixed-version pairing needs a second tailnet machine and was not run.
- **§5.7 carried-forward acceptance**: the oneshot seams ran live on the claude profile
  (`runCcQuery` readonly captured a 946-char ExitPlanMode plan; write-mode + guard overlay created a
  file; `runCcMicroQuery` exact-word reply). **Still blocked, needs operator input:** the literal
  GLM-profile run (`OPENROUTER_API_KEY` absent from `~/.config/anvil/env`), `runDevPipeline`
  end-to-end (same key, by design), and `autopilot.run` end-to-end (Todoist not connected).
- **CI (task 5)**: typecheck + typecheck:web + build:web green; `bun test` 1008 pass / 0 fail
  (2 skips = live-gated). Golden tests passed unchanged — no regeneration warranted.

Known parity hot-spots to check explicitly (from the seam map — each has driver coupling):
- `driver.ts` responsibilities beyond the query loop that must have found new homes: AskUserQuestion answer-echo suppression (`askQuestionIds`), file-offer/deliverable realization (`pendingOffers` → `buildFileOffer`/`maybeTaildrop`), turn dividers with token counts (`fmtTokens`), CLAUDE.md-reflection prompts (`supervisor.ts:1215`), daemon-initiated turns (`:1344`), team member drain on turn end (`onAgentResult` → `teams.drainQueuedMembers()`).
- `team-coordinator.ts:50,137` comments still reference "the member's InputQueue" — update comments to the queue-in-supervisor reality.
- Offline outbox migration from Plan 4 Task 6 verified against a client that queued commands pre-upgrade.
- `supervisor.planReviewer` (interactive adversarial plan review) lost its caller with the SDK driver (plan 7) — rewire onto the CC `ExitPlanMode` flow (the approve tool sees `input.plan`) or decide to drop the feature.

**Phase acceptance (design §5.8):** all upstream-parity features exercised in the fork's suites; the flag and SDK path are gone.
