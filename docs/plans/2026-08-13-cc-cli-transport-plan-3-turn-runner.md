# CC CLI Transport — Plan 3: Turn runner + retargeted mapper (core sessions CLI-direct)

**Goal:** Core sessions run CLI-direct behind a daemon flag: create/converse (streaming), interrupt, resume, model switch — with the existing web experience unchanged and unknown CC output surfacing as fallback cards.
**Architecture:** `cc/turn-runner.ts` replaces `AgentDriver` behind the exact supervisor surface (`prompt/interrupt/setModel/stop`, constructed at `supervisor.ts:1396-1435`); `agent/map.ts` retargets `SDKMessage`→`CCMessage`. Design §4.1/§4.2.

**GATES (from Plan 1):** golden recordings exist; Spike 3 (thinking deltas) answered; Assumption 5 (stdin-close = one turn) verified during recording. Code below marked ⚠ is directional until executed against those recordings — revise shapes, keep contracts.

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Fake-CC test harness (net-new — no fake-child idiom exists in repo) | pending | no | no |
| 2 | `cc/turn-runner.ts`: spawn/turn lifecycle state machine (TDD against harness) | pending | no | no |
| 3 | Stdin writer: port `attachmentBlock()`/`userMessage()` from `input-queue.ts` | pending | no | no |
| 4 | Retarget `map.ts` to `CCMessage`; add fallback classification | pending | no | no |
| 5 | Protocol: `fallback.card` ContentBlock arm + `ConversationEvent` arm + golden regen | pending | no | no |
| 6 | `TurnUsage` from `result` message (delta 2) + gauge degradation | pending | no | no |
| 7 | Supervisor integration behind `ANVIL_CC_DIRECT=1` flag | pending | no | no |
| 8 | Interrupt/resume/model-switch/status derivation end-to-end tests | pending | no | no |
| 9 | Session-id capture + `isResumeRejectedError` port + resume-fallback test | pending | no | no |

Key decisions already fixed by design/interview (do not relitigate at execution):
- **Harness style (Task 1):** repo never mocks `node:child_process`; the fake CC is a *real spawned bun script* (`test/helpers/fake-cc.ts` + fixture-driven stdout: replay a golden `.ndjson` with configurable pacing, exit code, mid-line crash, ignore-SIGINT mode). Aligns with "child processes are never faked" convention while keeping tests offline.
- **Turn lifecycle (Task 2):** spawn per turn with `--resume` after the first; states `idle → spawning → streaming → settling → idle`, plus `error`; single in-flight turn per session, daemon-side FIFO for queued prompts (replaces `InputQueue`); SIGINT → 5s grace → SIGKILL process group (use `session/procgroup.ts`); `NdjsonSplitter.flush()` tail on exit is parsed too (crash-mid-line case).
- **Command line (Task 2):** `[ccBinary, "-p", "--output-format","stream-json", "--input-format","stream-json", "--include-partial-messages", "--verbose", "--model", model, "--permission-mode", mode, ...(resumeId ? ["--resume", resumeId] : [])]`, cwd = session worktree, env = `agentEnv(s)` unchanged. Permission/MCP flags join in Plans 4–5.
- **Mapper (Task 4):** the cast lives in one place (`test/unit/map.test.ts` harness line) — retarget it; all 9 existing fixtures must keep passing verbatim (they pin the same wire shapes). New: `case "unknown"` → `fallback.card` event; unknown *content block* types inside assistant messages → same card path (size-capped JSON, design §4.7 delta 3).
- **Protocol (Task 5):** 4th `ContentBlock` arm `{kind:"fallback", ccType: string, json: string}` + matching `ConversationEvent` arm; edit `docs/plans/anvil-protocol.ts` (the real file — `anvild/protocol.ts` is a symlink); regen wire-type golden via `bun test/contract/regen-golden.ts`; `wire-shape.test.ts` inline GOLDEN untouched (no pinned interface changes).
- **TurnUsage (Task 6):** `q.usage_EXPERIMENTAL…()`/`q.getContextUsage()` have no stream-json equivalent. Extract from `result`: `usage`/`modelUsage`/`total_cost_usd`. ⚠ Whether `rate_limits`/context occupancy appear in `result` is answered by the Plan 1 recordings — if absent, `rateLimits: null` + `contextUsage: null` degrade the gauge gracefully (consumer `onAgentResult` at `supervisor.ts:1962-1996` already handles null) and rewrite the SDK-citing doc comments at `protocol.ts:198,208`. `costUsd`/`model` are currently never read by the consumer — keep populating, note it.
- **Supervisor (Task 7):** `ensureDriver` branches on the flag to construct the turn-runner with the same 15-arg-equivalent deps (brokers, renderer, env, callbacks); `.stop()` call sites (6, incl. shutdown `Promise.allSettled` at `:1674`) map to "SIGINT if turn in flight, clear queue"; `setModel` (`:1525`) just records — next spawn reads it.
- **Fallback card UI (Task 7):** `showFallbackCard(ccType, json)` in `web/src/dialogs.ts` beside `showPermission` (`:763`) — inline conversation card, collapsed `<details>`, existing deps suffice; dispatch arm in `main.ts` `onEvent` switch; DOM test per `test/web/dialogs.test.ts` template.

**Phase acceptance (design §5.3):** from the web client with `ANVIL_CC_DIRECT=1`: create session → streamed deltas render → interrupt mid-tool → next turn resumes with context intact → switch model mid-conversation (next turn's init reports it) → `claude --resume <id>` works in a terminal. Offline test suite green without the flag too (SDK path untouched until Plan 8).
