# SDK usage inventory (Phase 1 deliverable — design §5 phase 1)

Every `@anthropic-ai/claude-agent-sdk` touch point and its disposition. Regen check:
`grep -rn "claude-agent-sdk" src --include='*.ts'` must list exactly the Import sites below.

## query() call sites (6)
| Site | Shape | Converts in |
|---|---|---|
| `src/agent/driver.ts:191` | long-lived streaming | Plan 3 (turn-runner) |
| `src/agent/query.ts:47` (`runAgentQuery`) | one-shot, plan-mode capable | Plan 7 (`cc/oneshot.ts`) |
| `src/integrations/autopilot.ts:79` (private `runQuery`) | one-shot, Claude-only near-duplicate | Plan 7 (absorbed into `cc/oneshot.ts`) |
| `src/agent/branch-kind.ts:48` | one-shot haiku, maxTurns 1 | Plan 7 |
| `src/agent/goal.ts:73` (`judgeGoal`) | one-shot haiku, maxTurns 1 | Plan 7 |
| `src/agent/icon.ts:34` (`pickIcon`) | one-shot sonnet | Plan 7 |

## Other SDK surface
| Module | SDK surface | Disposition |
|---|---|---|
| `src/agent/map.ts` | `SDKMessage` input type | Plan 3: retarget cast to `CCMessage` (one line in test harness) |
| `src/agent/input-queue.ts` | `SDKUserMessage`, `InputQueue` | Plan 3: port `attachmentBlock()`/`userMessage()` into turn-runner stdin writer; queue class deleted |
| `src/agent/permissions.ts` | `HookCallback`, `PreToolUseHookInput` | Plan 4: `PermissionBroker` survives unchanged; hook side → `cc/permission-server.ts` |
| `src/agent/questions.ts` | `CanUseTool`, `PermissionResult` | Plan 4: `QuestionBroker` survives; `makeCanUseTool` wire shape (`:118-133`) reproduced by MCP `approve` tool |
| `src/agent/default-tools.ts`, `team-tools.ts`, `member-tools.ts`, `planning-tools.ts` | `createSdkMcpServer`, `tool` | Plan 5: re-host on daemon HTTP MCP endpoint; handlers + `*ToolDeps` untouched |
| `src/agent/goal.ts` (`makeStopHook`) | `HookCallback` | Plan 5: CC `Stop` hook in settings overlay (must return `{decision:"block", reason}` — see goal.ts:110-115) |
| `src/agent/pipeline-guard.ts` | `HookCallback` | Plan 7: CC PreToolUse hook in pipeline settings overlay ([SEC-H4] retained, signed off 2026-08-13) |
| `src/agent/cli.ts` | CLI locator | Plan 2 bridges `ANVIL_CLI_PATH` to managed install; deleted in Plan 7 |
| `src/agent/danger-list.ts`, autonomy engine in `permissions.ts` | — | Plan 4: deleted (fully CC-native) |
| `src/auth/guard.ts`, `src/auth/degrade.ts` | — | Plan 4: deleted (defer-to-CC auth); rewire `supervisor.onTurnError` |
| `test/integration/attachment-flow.test.ts` etc. | global `mock.module` SDK stub | Plan 7: hazard disappears with the dependency |
