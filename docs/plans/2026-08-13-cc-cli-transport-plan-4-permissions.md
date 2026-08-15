# CC CLI Transport — Plan 4: Permission MCP server, questions, permissionMode delta, guard deletion

**Goal:** CC's own permission engine drives remote dialogs via the daemon's `approve` MCP tool; AskUserQuestion renders as the existing question card; `autonomy` becomes `permissionMode`; danger list + auth guard are deleted.
**Architecture:** `cc/permission-server.ts` (HTTP MCP endpoint on the daemon's existing listener, per-session bearer) bridges to the unchanged `PermissionBroker`/`QuestionBroker`. Design §4.4, §4.3, §4.7 delta 1.

**GATES:** Plan 3 merged (turn-runner spawns with `--permission-prompt-tool mcp__anvild__approve --mcp-config <session>.mcp.json`). **Spike first — this plan's Task 1 resolves design Assumption 3 before anything else is built.**

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | SPIKE (LIVE): permission-tool round trip + AskUserQuestion behavior in `-p` mode | done | yes | yes |
| 2 | `cc/permission-server.ts`: MCP endpoint + `approve` tool → brokers | done | yes | yes |
| 3 | `cc/mcp-config.ts`: per-session `.mcp.json` writer + bearer lifecycle | done | yes | yes |
| 4 | Question path: reproduce `questions.ts:118-133` wire shape (or spike fallback) | done | yes | yes |
| 5 | Protocol delta 1: `AutonomyPolicy` → `PermissionMode` (9 sites) + goldens regen | done | yes | yes |
| 6 | Web: picker relabel in `dialogs.ts` (one file) + offline-outbox hazard note | done | yes | yes |
| 7 | Delete `danger-list.ts`, autonomy engine, `auth/guard.ts`, `auth/degrade.ts`; rewire `onTurnError` | done | yes | yes |
| 8 | Kill-during-`awaiting_permission` semantics + tests | done | yes | yes |

Execution notes (2026-08-13):
- **Assumption 3 fully confirmed live** (`test/tools/probe-cc-permission.ts`, cc 2.1.231): the
  approve tool receives prompt-worthy calls AND AskUserQuestion; allow/deny/updatedInput honored;
  .mcp.json bearer headers arrive; CC auto-allows safe commands (the "allowlisted → no dialog"
  acceptance for free). No PreToolUse fallback needed — Task 4 rides the approve tool.
- **PROTOCOL_VERSION 4→5** (breaking rename per policy). `regen-golden.ts` was silently broken
  (importing a .test.ts throws outside the runner) — helper extracted to `wire-types.ts`.
- **Wider blast radius than the 9-site inventory**: the rename reached team-gate/team-coordinator/
  autopilot defaults (interactive `default`, autostart `bypassPermissions`); the SDK path went
  CC-native too (hook no longer decides; engine asks park via shared `askPermission` used by both
  transports); the danger table survives ONLY inside pipeline-guard ([SEC-H4]); `checkAuth`'s
  shape check moved to accounts.ts (roster/health UX) while the §3 boot refusal + auto-degrade
  tracker (scheduler skips, recover endpoint, reflection gate) were deleted.
- **Phase acceptance (§5.4) passed live end-to-end**: TurnRunner + real claude → daemon MCP
  endpoint → permission card (`awaiting_permission`) → allow via `resolvePermission` → command ran;
  AskUserQuestion → question card → answer → model echoed it. Kill-during-awaiting force-denies
  parked prompts (supervisor.interrupt) so the CLI never hangs on the approve response.
- **Plan-8 flag**: `buildAgentEnv` still REQUIRES a roster token; the CLI itself can auth via its
  own keychain/credentials — revisit under defer-to-CC when the SDK path is deleted.

Fixed decisions and known facts:
- **Task 1 spike** extends the existing scaffolding `test/tools/probe-askquestion.ts` (already in-repo): drive a real `-p` turn whose settings force a prompt; verify (a) the CLI calls the configured MCP `approve` tool, (b) `{behavior:"allow", updatedInput}` is honored, (c) AskUserQuestion arrives via the same channel and the exact shape from `questions.ts:118-133` — `updatedInput: {...input, answers: {[exact question text]: label | label[]}, annotations?}` — injects answers. Record findings as comments in the probe. **If (c) fails:** documented fallback (design §4.4) — a PreToolUse CC hook in the session settings overlay that parks the question and returns the answer; Task 4 then builds that instead.
- **Task 2:** serve MCP (streamable HTTP) from the existing `http.ts` listener at `/api/cc/mcp/:sessionId` with a per-session bearer minted at session create; `approve(tool_name, input, …)` → `newId()` request → `broker.request(...)` → fan `permission.request` event + push (existing paths) → await → map `allow/allow_always/deny` + `updatedInput` into the MCP result. `allow_always` additionally records a session-scoped auto-allow for that tool signature *inside the approve tool* (CC-native config stays untouched — this only affects re-asks the daemon itself answers).
- **Task 3:** `.mcp.json` per session in the session state dir: `{mcpServers: {anvild: {type:"http", url, headers:{Authorization}}}}` plus (Plan 5) the tools server. Rotate bearer on session reset.
- **Task 5:** exact inventory (from seam map): `protocol.ts:119-124` type; `:273` required `Session.autonomy`; `:1135`; `:1199-1202` (`session.set_autonomy` → `session.set_permission_mode`, field `mode`); `:1425/:1435` autopilot defaults (interactive default `"default"`, autostart default `"bypassPermissions"`); `:1587` union; `dispatch.ts:140`; `supervisor.ts:1531-1537`; plus `default-tools.ts:3` import + `summarize()` projection at `:49`. Edit `docs/plans/anvil-protocol.ts` (symlink source). Wire-type golden changes (renamed cmd) ⇒ `bun test/contract/regen-golden.ts`; `typecheck:web` breaking on the rename is the designed detector for missed web sites.
- **Task 6:** all web changes in `web/src/dialogs.ts`: `DEFAULT_AUTONOMY` (`:282`, becomes `DEFAULT_PERMISSION_MODE = "bypassPermissions"` — preserves today's default behavior), `AUTONOMY_PICKER` labels (`:283-288`), `selectedAutonomy()` (`:290`), two dialog call sites + `createOfflineSession()` (`:525`). **Hazard (seam map):** `dialogs.ts:514-538` persists raw `session.create` commands into `localStorage["anvil.sessions"]` and the offline outbox — add a one-line outbox migration (drop/rename the stale `autonomy` key on flush) even under fresh-start, since a queued create can straddle the upgrade.
- **Task 7:** `auth/degrade.ts` is consumed at `supervisor.ts` `onTurnError` (`:1390-1393`) and `onAgentResult` (`recordTurnSuccess`) — deletion rewires both to plain error propagation. Grep-clean acceptance: `grep -rn "danger-list\|authDegrade\|AutonomyPolicy" src web` → no hits.
- **Task 8:** design §7 row: killing a turn blocked in `approve` force-resolves the broker prompt as denied, marks the turn interrupted, UI shows "interrupted while awaiting"; on resume the question is not re-asked. Test with the Plan 3 fake-CC harness (ignore-SIGINT mode covers the escalation path).

**Phase acceptance (design §5.4):** a tool call your real CC settings would prompt for raises a dialog on a second device; answering there unblocks the turn; AskUserQuestion renders as the existing question card; a settings-allowlisted call produces **no** dialog.
