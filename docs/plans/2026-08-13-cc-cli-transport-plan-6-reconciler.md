# CC CLI Transport — Plan 6: Transcript reconciler + PTY attach handoff

**Goal:** Disk is truth: the daemon heals its event log from `~/.claude/projects/<slug>/<sessionId>.jsonl` after crashes, and turns taken in an attached real terminal appear in every client's history after detach.
**Architecture:** `cc/reconcile.ts`; attach/detach rides the existing side-panel terminal (`session/terminal-manager.ts`) running `claude --resume` in the PTY. Design §4.9.

**GATES:** Plan 3 merged. Recording needed: one PTY-driven turn's transcript JSONL (extend the Plan 1 recorder with a `transcript.jsonl` capture — the on-disk line shapes are a *different* format from stream-json stdout and must be pinned by their own fixture before coding).

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Record + check in a transcript-JSONL fixture; vendored transcript line types | pending | no | no |
| 2 | `cc/reconcile.ts`: diff transcript vs event log by message uuid; backfill through renderer | pending | no | no |
| 3 | Crash-heal: run reconciler on daemon boot + abnormal turn end | pending | no | no |
| 4 | Attach flow: `attached` sub-state (only from `idle`), headless turns blocked, PTY spawns `claude --resume` | pending | no | no |
| 5 | Detach flow: reconcile-backfill, return to `idle`; kill-daemon-mid-turn integration test | pending | no | no |

Fixed decisions:
- Transcript path derivation: CC slugs the cwd into `~/.claude/projects/<slug>/` — derive the slug the same way CC does (verify against the fixture; do not hand-roll from assumption).
- Dedupe key is the transcript line `uuid`; the event log gains a `ccUuid` correlation field on mapped events (additive protocol change, golden regen) so replay/backfill never double-applies (design §7 "must never double-apply").
- Backfilled markdown renders through the normal `MarkdownRenderer` pipeline; backfilled events append with fresh `seq` (clients already handle catch-up replay by `seq` — no client change).
- Attach UX: reuse the existing terminal panel; the only new rules are the `attached` gate (reject `prompt.send` with a clear error) and detach-reconcile.
- Kill-during-`awaiting_permission` interaction (Plan 4 Task 8 semantics) applies to attach too: attach is refused while a permission/question card is parked (session is not `idle`).

**Phase acceptance (design §5.6):** `kill -9` the daemon mid-turn → restart → event log heals from transcript; a turn taken in the attached PTY appears in the client history after detach.
