# CC CLI Transport — Plan 4: Permission MCP server, questions, permissionMode delta, guard deletion

**Goal:** CC's own permission engine drives remote dialogs via the daemon's `approve` MCP tool; AskUserQuestion renders as the existing question card; `autonomy` becomes `permissionMode`; danger list + auth guard are deleted.
**Architecture:** `cc/permission-server.ts` (HTTP MCP endpoint on the daemon's existing listener, per-session bearer) bridges to the unchanged `PermissionBroker`/`QuestionBroker`. Design §4.4, §4.3, §4.7 delta 1.

**GATES:** Plan 3 merged (turn-runner spawns with `--permission-prompt-tool mcp__anvild__approve --mcp-config <session>.mcp.json`). **Spike first — this plan's Task 1 resolves design Assumption 3 before anything else is built.**

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | SPIKE (LIVE): permission-tool round trip + AskUserQuestion behavior in `-p` mode | pending | no | no |
| 2 | `cc/permission-server.ts`: MCP endpoint + `approve` tool → brokers | pending | no | no |
| 3 | `cc/mcp-config.ts`: per-session `.mcp.json` writer + bearer lifecycle | pending | no | no |
| 4 | Question path: reproduce `questions.ts:118-133` wire shape (or spike fallback) | pending | no | no |
| 5 | Protocol delta 1: `AutonomyPolicy` → `PermissionMode` (9 sites) + goldens regen | pending | no | no |
| 6 | Web: picker relabel in `dialogs.ts` (one file) + offline-outbox hazard note | pending | no | no |
| 7 | Delete `danger-list.ts`, autonomy engine, `auth/guard.ts`, `auth/degrade.ts`; rewire `onTurnError` | pending | no | no |
| 8 | Kill-during-`awaiting_permission` semantics + tests | pending | no | no |

Fixed decisions and known facts:
- **Task 1 spike** extends the existing scaffolding `test/tools/probe-askquestion.ts` (already in-repo): drive a real `-p` turn whose settings force a prompt; verify (a) the CLI calls the configured MCP `approve` tool, (b) `{behavior:"allow", updatedInput}` is honored, (c) AskUserQuestion arrives via the same channel and the exact shape from `questions.ts:118-133` — `updatedInput: {...input, answers: {[exact question text]: label | label[]}, annotations?}` — injects answers. Record findings as comments in the probe. **If (c) fails:** documented fallback (design §4.4) — a PreToolUse CC hook in the session settings overlay that parks the question and returns the answer; Task 4 then builds that instead.
- **Task 2:** serve MCP (streamable HTTP) from the existing `http.ts` listener at `/api/cc/mcp/:sessionId` with a per-session bearer minted at session create; `approve(tool_name, input, …)` → `newId()` request → `broker.request(...)` → fan `permission.request` event + push (existing paths) → await → map `allow/allow_always/deny` + `updatedInput` into the MCP result. `allow_always` additionally records a session-scoped auto-allow for that tool signature *inside the approve tool* (CC-native config stays untouched — this only affects re-asks the daemon itself answers).
- **Task 3:** `.mcp.json` per session in the session state dir: `{mcpServers: {anvild: {type:"http", url, headers:{Authorization}}}}` plus (Plan 5) the tools server. Rotate bearer on session reset.
- **Task 5:** exact inventory (from seam map): `protocol.ts:119-124` type; `:273` required `Session.autonomy`; `:1135`; `:1199-1202` (`session.set_autonomy` → `session.set_permission_mode`, field `mode`); `:1425/:1435` autopilot defaults (interactive default `"default"`, autostart default `"bypassPermissions"`); `:1587` union; `dispatch.ts:140`; `supervisor.ts:1531-1537`; plus `default-tools.ts:3` import + `summarize()` projection at `:49`. Edit `docs/plans/anvil-protocol.ts` (symlink source). Wire-type golden changes (renamed cmd) ⇒ `bun test/contract/regen-golden.ts`; `typecheck:web` breaking on the rename is the designed detector for missed web sites.
- **Task 6:** all web changes in `web/src/dialogs.ts`: `DEFAULT_AUTONOMY` (`:282`, becomes `DEFAULT_PERMISSION_MODE = "bypassPermissions"` — preserves today's default behavior), `AUTONOMY_PICKER` labels (`:283-288`), `selectedAutonomy()` (`:290`), two dialog call sites + `createOfflineSession()` (`:525`). **Hazard (seam map):** `dialogs.ts:514-538` persists raw `session.create` commands into `localStorage["anvil.sessions"]` and the offline outbox — add a one-line outbox migration (drop/rename the stale `autonomy` key on flush) even under fresh-start, since a queued create can straddle the upgrade.
- **Task 7:** `auth/degrade.ts` is consumed at `supervisor.ts` `onTurnError` (`:1390-1393`) and `onAgentResult` (`recordTurnSuccess`) — deletion rewires both to plain error propagation. Grep-clean acceptance: `grep -rn "danger-list\|authDegrade\|AutonomyPolicy" src web` → no hits.
- **Task 8:** design §7 row: killing a turn blocked in `approve` force-resolves the broker prompt as denied, marks the turn interrupted, UI shows "interrupted while awaiting"; on resume the question is not re-asked. Test with the Plan 3 fake-CC harness (ignore-SIGINT mode covers the escalation path).

**Phase acceptance (design §5.4):** a tool call your real CC settings would prompt for raises a dialog on a second device; answering there unblocks the turn; AskUserQuestion renders as the existing question card; a settings-allowlisted call produces **no** dialog.
