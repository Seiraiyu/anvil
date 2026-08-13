# CC CLI Transport — Plan 7: One-shot conversion + SDK deletion

**Goal:** Every remaining SDK `query()` call site runs CLI-direct through `cc/oneshot.ts`; the pipeline guard becomes a CC hook; `@anthropic-ai/claude-agent-sdk` leaves the lockfile.
**Architecture:** Design §4.6. The pipeline is already behind one injectable seam — `src/pipeline/adapters.ts:11` `defaultAgent: AgentFn` — so the pipeline retarget is a one-line change once `cc/oneshot.ts` matches `runAgentQuery`'s contract.

**GATES:** Plans 3–5 merged.

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | `cc/oneshot.ts`: `runCcQuery(prompt, opts) → {text, plan?}` matching `AgentQueryResult` | done | yes | yes |
| 2 | Retarget `pipeline/adapters.ts` `defaultAgent` (one line) + pipeline tests | done | yes | yes |
| 3 | Absorb `integrations/autopilot.ts` private `runQuery` (3 call sites) | done | yes | yes |
| 4 | Convert micro-queries: `branch-kind.ts`, `goal.ts` `judgeGoal`, `icon.ts` `pickIcon` | done | yes | yes |
| 5 | Pipeline guard as CC PreToolUse hook in pipeline settings overlay ([SEC-H4]) | done | yes | yes |
| 6 | Delete the SDK: dependency, `agent/cli.ts`, `mock.module` stubs, driver remnants | done | yes | yes |

**Execution notes (2026-08-13):** tasks 1+5 landed together — the guard overlay is written by
`runCcQuery` itself (see the task-5 amendment below), so task 2 stayed one line. Micro-queries ride
`--tools ""` (the CLI's documented disable-all form; the installed CLI has no `--max-turns`, and
no-tools is what guarantees a single turn). Offline acceptance: `grep -c "claude-agent-sdk"
anvild/bun.lock` → 0; `bun install --frozen-lockfile && bun test` → 1002 pass / 0 fail; all four CI
gates green. The §5.7 LIVE acceptance (an autopilot run + a pipeline phase completing CLI-direct
with the GLM env profile) still needs a run against a real daemon — the offline suite covers the
spawn contract (args + env profiles) via fake-cc.

Fixed decisions and known facts:
- **Task 1 contract** (from `agent/query.ts`): options `{model: ModelSpec, cwd?, readonly?, signal?, accounts?, accountId?}`; `readonly` ⇒ `--permission-mode plan`, plan captured from the `ExitPlanMode` tool_use `input.plan` in the stream; env via `buildAgentEnv` unchanged (OpenRouter/GLM profiles are env-only — dual-model parity costs nothing); `signal` aborts by killing the child. **Deliberate change:** upstream's `runAgentQuery` sets `settingSources: []` (config-isolated one-shots); the fork drops that isolation — one-shots are CC-native like everything else, and unattended safety comes from Task 5's guard hook, not from hiding config. This means pipeline runs see the user's CLAUDE.md/settings; that is the intended "fully CC-native" behavior, recorded here so nobody re-adds isolation as a reflex.
- **Task 4:** all three micro-queries share one shape (haiku/sonnet, `maxTurns:1`, no tools, bypassPermissions, short AbortController, heuristic fallback on failure) — one `runCcMicroQuery(prompt, {model, timeoutMs})` helper; `branch-kind`/`icon` keep their existing fallbacks (`heuristicKind()`, default icon), `judgeGoal` keeps `parseVerdict` fail-open semantics.
- **Task 5:** `makePipelineGuardHook` logic (danger-deny for third-party write phases) ports to a CC PreToolUse hook command in the *pipeline's* settings overlay only — interactive sessions unaffected. Signed off 2026-08-13. **Execution amendment (2026-08-13):** the hook is a *generated self-contained script* (danger tables serialized from `pipeline-guard.ts` at spawn time, run via `bun <script>`), written per run by `runCcQuery` itself alongside a per-run `--settings` overlay — NOT an HTTP callback into the daemon. Rationale: one-shots have no session id/bearer, an HTTP guard would thread daemon context through every caller (Task 2 stops being one line), and installing the guard inside `runCcQuery` makes it impossible to forget — which matters because the guard's allow-verdicts are also what lets headless plan-mode runs approve `ExitPlanMode` and terminate at all (see the old `integrations/autopilot.ts` runQuery comment). Equivalence is test-pinned: the generated script's verdicts must match `pipelineGuardVerdict` case-for-case. Caveat recorded: the hook command needs `bun` on the child's PATH (true for all current deployments; compiled-binary packaging is a plan-9 concern).
- **Task 6:** delete `@anthropic-ai/claude-agent-sdk` from `package.json`, `agent/cli.ts` (`ANVIL_CLI_PATH` reading moves into turn-runner spawn), `agent/driver.ts`, `agent/query.ts`, `agent/input-queue.ts`, and every `mock.module("@anthropic-ai/claude-agent-sdk", …)` stub (`test/integration/attachment-flow.test.ts:10-16` documents the global-stub hazard that disappears with it). Acceptance: `grep -c "claude-agent-sdk" anvild/bun.lock` → 0; `bun install --frozen-lockfile && bun test` green.
  **Execution amendments (2026-08-13, gate re-validation findings):**
  - *Flag-flip pull-forward:* deleting `agent/driver.ts` forces the supervisor change plan 8 task 4 had reserved — `ensureDriver` can no longer construct `AgentDriver`, so the `ANVIL_CC_DIRECT` check and the SDK branch are removed here and ALL sessions go CLI-direct from this phase on. Plan 8 task 4 shrinks to verification + dead-test cleanup. (Decision confirmed 2026-08-13.)
  - *Correction:* "attachment logic long since ported" was wrong — `cc/turn-runner.ts` *imports* `userMessage`/`InlineAttachment` from `agent/input-queue.ts`. The message/attachment half moves to an SDK-free module; only the `InputQueue` class + `SDKUserMessage` typing are deleted.
  - *Driver remnants:* `TurnUsage`/`ResultRecorder`/`isResumeRejectedError` (imported by supervisor + turn-runner) move into the CC transport before `driver.ts` is deleted.
  - *Wider SDK-type surface than listed:* `permissions.ts` (`makePreToolUseHook`), `questions.ts` (`makeCanUseTool`), `goal.ts` (`makeStopHook`, superseded by supervisor `ccStopHook`), `pipeline-guard.ts` (`makePipelineGuardHook`) lose their driver-only SDK-typed exports; four obsolete SDK spike tools under `test/tools/` (compile-spike, sdk-smoke, probe-subagent-perm, probe-askquestion) are deleted to keep typecheck green.
  - *Known parity gap for plan 8:* `supervisor.planReviewer` (interactive adversarial plan review) rode only the SDK driver's plan-proposed hook; it keeps a plan-8 TODO to be rewired onto the CC `ExitPlanMode` flow.

**Phase acceptance (design §5.7):** an autopilot run and a pipeline phase complete CLI-direct with the GLM env profile; the SDK is absent from the lockfile.
