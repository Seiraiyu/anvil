# CC CLI Transport — Plan 7: One-shot conversion + SDK deletion

**Goal:** Every remaining SDK `query()` call site runs CLI-direct through `cc/oneshot.ts`; the pipeline guard becomes a CC hook; `@anthropic-ai/claude-agent-sdk` leaves the lockfile.
**Architecture:** Design §4.6. The pipeline is already behind one injectable seam — `src/pipeline/adapters.ts:11` `defaultAgent: AgentFn` — so the pipeline retarget is a one-line change once `cc/oneshot.ts` matches `runAgentQuery`'s contract.

**GATES:** Plans 3–5 merged.

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | `cc/oneshot.ts`: `runCcQuery(prompt, opts) → {text, plan?}` matching `AgentQueryResult` | pending | no | no |
| 2 | Retarget `pipeline/adapters.ts` `defaultAgent` (one line) + pipeline tests | pending | no | no |
| 3 | Absorb `integrations/autopilot.ts` private `runQuery` (3 call sites) | pending | no | no |
| 4 | Convert micro-queries: `branch-kind.ts`, `goal.ts` `judgeGoal`, `icon.ts` `pickIcon` | pending | no | no |
| 5 | Pipeline guard as CC PreToolUse hook in pipeline settings overlay ([SEC-H4]) | pending | no | no |
| 6 | Delete the SDK: dependency, `agent/cli.ts`, `mock.module` stubs, driver remnants | pending | no | no |

Fixed decisions and known facts:
- **Task 1 contract** (from `agent/query.ts`): options `{model: ModelSpec, cwd?, readonly?, signal?, accounts?, accountId?}`; `readonly` ⇒ `--permission-mode plan`, plan captured from the `ExitPlanMode` tool_use `input.plan` in the stream; env via `buildAgentEnv` unchanged (OpenRouter/GLM profiles are env-only — dual-model parity costs nothing); `signal` aborts by killing the child. **Deliberate change:** upstream's `runAgentQuery` sets `settingSources: []` (config-isolated one-shots); the fork drops that isolation — one-shots are CC-native like everything else, and unattended safety comes from Task 5's guard hook, not from hiding config. This means pipeline runs see the user's CLAUDE.md/settings; that is the intended "fully CC-native" behavior, recorded here so nobody re-adds isolation as a reflex.
- **Task 4:** all three micro-queries share one shape (haiku/sonnet, `maxTurns:1`, no tools, bypassPermissions, short AbortController, heuristic fallback on failure) — one `runCcMicroQuery(prompt, {model, timeoutMs})` helper; `branch-kind`/`icon` keep their existing fallbacks (`heuristicKind()`, default icon), `judgeGoal` keeps `parseVerdict` fail-open semantics.
- **Task 5:** `makePipelineGuardHook` logic (danger-deny for third-party write phases) ports to a CC PreToolUse hook command in the *pipeline's* settings overlay only — interactive sessions unaffected. Signed off 2026-08-13.
- **Task 6:** delete `@anthropic-ai/claude-agent-sdk` from `package.json`, `agent/cli.ts` (`ANVIL_CLI_PATH` reading moves into turn-runner spawn), `agent/driver.ts`, `agent/query.ts`, `agent/input-queue.ts` (attachment logic long since ported), and every `mock.module("@anthropic-ai/claude-agent-sdk", …)` stub (`test/integration/attachment-flow.test.ts:10-16` documents the global-stub hazard that disappears with it). Acceptance: `grep -c "claude-agent-sdk" anvild/bun.lock` → 0; `bun install --frozen-lockfile && bun test` green.

**Phase acceptance (design §5.7):** an autopilot run and a pipeline phase complete CLI-direct with the GLM env profile; the SDK is absent from the lockfile.
