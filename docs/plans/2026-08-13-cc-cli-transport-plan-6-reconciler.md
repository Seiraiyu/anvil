# CC CLI Transport — Plan 6: Transcript reconciler + PTY attach handoff

**Goal:** Disk is truth: the daemon heals its event log from `~/.claude/projects/<slug>/<sessionId>.jsonl` after crashes, and turns taken in an attached real terminal appear in every client's history after detach.
**Architecture:** `cc/reconcile.ts`; attach/detach rides the existing side-panel terminal (`session/terminal-manager.ts`) running `claude --resume` in the PTY. Design §4.9.

**GATES:** Plan 3 merged. Recording needed: one PTY-driven turn's transcript JSONL (extend the Plan 1 recorder with a `transcript.jsonl` capture — the on-disk line shapes are a *different* format from stream-json stdout and must be pinned by their own fixture before coding).

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Record + check in a transcript-JSONL fixture; vendored transcript line types | done | yes | yes |
| 2 | `cc/reconcile.ts`: diff transcript vs event log by message uuid; backfill through renderer | done | yes | yes |
| 3 | Crash-heal: run reconciler on daemon boot + abnormal turn end | done | yes | yes |
| 4 | Attach flow: `attached` sub-state (only from `idle`), headless turns blocked, PTY spawns `claude --resume` | done | yes | yes |
| 5 | Detach flow: reconcile-backfill, return to `idle`; kill-daemon-mid-turn integration test | done | yes | yes |

Execution notes (2026-08-13):
- **Recorder findings** (`test/tools/record-cc-transcript.ts`, fixture `test/fixtures/cc-transcript/`,
  cc 2.1.231): slug = cwd with `[^A-Za-z0-9]` → `-` (verified by locating the real file, not assumed);
  stream-json stdout uuid == transcript line uuid; `--resume` appends to the SAME file for headless AND
  interactive TUI (ptySid === sid — the attach-flow assumption, now pinned). Two traps the fixture
  pins: the recorder must strip `CLAUDE_CODE_CHILD_SESSION` (an inherited marker silently DISABLES TUI
  transcript persistence), and `/exit`-style command echoes arrive as **non-isMeta** user lines — the
  reconciler filters by content tag (`<command-name>`, `<local-command-stdout>`, interrupt markers) too.
- **User-prompt dedupe deviation**: the daemon logs `message.user` before CC mints the line uuid, so
  uuid-only dedupe (the plan's fixed decision) can't cover user prompts. Backfilled events carry
  `ccUuid`; daemon-authored prompts are matched by an order-insensitive text multiset instead. First
  text block only, so a prompt with attachments still matches.
- **Legacy guard**: a log holding assistant history with zero `ccUuid` predates plan-6 stamping — a
  reconcile there would duplicate whole conversations (live daemons upgraded in place). Skipped with a
  warning; the session becomes heal-able after its next live turn.
- **Attach protocol** (additive, no bump): `cc.attach`/`cc.detach` commands (`session.attach` was taken
  by the WS-subscribe command), `Session.attached`, reserved termId `CC_ATTACH_TERM_ID = "cc"` riding
  the existing terminal channel/chip strip (TerminalManager gained `command`/`title`/`onExit`;
  `cttyWrap` generalizes the ctty discipline). PTY exit = implicit detach; the cc chip's ✕ IS the
  detach button. `terminal.open` on "cc" without an attach is refused (never a plain shell there).
  `SupervisorConfig.spawnTerminal` is the test-only PTY seam (goalJudge precedent).
- **Phase acceptance (§5.6)** encoded offline in `test/integration/cc-crash-heal.test.ts`: a fresh
  Supervisor over the same state dir (kill -9 semantics, no shutdown flush) boot-heals a partial turn
  from a planted golden transcript, idempotent across a third restart; attach→detach backfills exactly
  the PTY-typed turn as fresh-seq watermark-replayable events.

Fixed decisions:
- Transcript path derivation: CC slugs the cwd into `~/.claude/projects/<slug>/` — derive the slug the same way CC does (verify against the fixture; do not hand-roll from assumption).
- Dedupe key is the transcript line `uuid`; the event log gains a `ccUuid` correlation field on mapped events (additive protocol change, golden regen) so replay/backfill never double-applies (design §7 "must never double-apply").
- Backfilled markdown renders through the normal `MarkdownRenderer` pipeline; backfilled events append with fresh `seq` (clients already handle catch-up replay by `seq` — no client change).
- Attach UX: reuse the existing terminal panel; the only new rules are the `attached` gate (reject `prompt.send` with a clear error) and detach-reconcile.
- Kill-during-`awaiting_permission` interaction (Plan 4 Task 8 semantics) applies to attach too: attach is refused while a permission/question card is parked (session is not `idle`).

**Phase acceptance (design §5.6):** `kill -9` the daemon mid-turn → restart → event log heals from transcript; a turn taken in the attached PTY appears in the client history after detach.
