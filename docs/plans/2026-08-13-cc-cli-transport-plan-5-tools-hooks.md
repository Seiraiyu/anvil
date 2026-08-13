# CC CLI Transport — Plan 5: Anvil tool servers, settings-overlay hooks, skills re-source

**Goal:** Anvil's in-process SDK MCP tools become daemon-hosted MCP servers; anvil feature hooks (goal stop-hook) become real CC hooks via per-session settings overlay; skill autocomplete reads the user's real `~/.claude`.
**Architecture:** Design §4.5, §4.3. Sign-off 2026-08-13: daemon-injected hooks are fine wherever needed, provided they are CC hooks (settings overlay), never SDK callbacks.

**GATES:** Plans 3–4 merged (turn-runner + `.mcp.json` writer exist).

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | MCP tool host: serve the 4 role servers over the Plan-4 HTTP MCP endpoint | pending | no | no |
| 2 | Re-register: role ternary (`supervisor.ts:1411-1420`) → entries in session `.mcp.json` | pending | no | no |
| 3 | Settings overlay writer: per-session `--settings` file, additive hooks only | pending | no | no |
| 4 | Goal stop-hook as CC `Stop` hook → daemon HTTP callback | pending | no | no |
| 5 | Skills/commands autocomplete re-source from real `~/.claude` | pending | no | no |
| 6 | Delete `createSdkMcpServer` imports; handler/deps tests keep passing | pending | no | no |

Fixed decisions and known facts:
- **Task 1:** the 4 modules (`default-tools.ts`, `team-tools.ts`, `member-tools.ts`, `planning-tools.ts`) already split pure handlers + `*ToolDeps` from SDK registration precisely "so tests can invoke handlers without a live SDK server" (their own comment). Only the `createSdkMcpServer({name, tools})` wrapper is replaced by an MCP-over-HTTP host module (`cc/tool-host.ts`) that serves the same tool names — keep the `mcp__anvil__*` / `mcp__anvil_team__*` id shape (`*_TOOL_IDS` arrays unchanged) so transcripts and `extraAllowedTools` allowlisting stay identical. Zod schemas carry over as-is.
- **Task 2:** the 4-way role ternary moves from AgentDriver construction into `cc/mcp-config.ts`: default → `anvil` server entry; lead → `anvil_team`; member → `anvil_member`; planner → `anvil_planning`. `extraAllowedTools` becomes `--allowedTools` entries on the spawn (pre-approves anvil's own tools; everything else stays under CC's permission engine).
- **Task 3:** overlay JSON written next to `.mcp.json`; contains **only additive anvil hooks**; user/project settings load normally (fully CC-native). Hook commands are small `curl`-to-daemon-localhost invocations with the session bearer.
- **Task 4:** port `makeStopHook` (`agent/goal.ts`) semantics: on `Stop`, POST transcript tail (`GOAL_TRANSCRIPT_LINES = 40`) to the daemon; daemon runs `judgeGoal` (Plan 7's `cc/oneshot.ts` — until then, keep SDK `judgeGoal` behind the flag); unmet goal ⇒ hook replies with CC's blocking-decision JSON. **Carry the hard-won finding from `goal.ts:110-115`: the reply must be `{decision:"block", reason}` — `additionalContext` is refused by the model as prompt injection.** Verify the CC-hook JSON equivalent during implementation (documented hooks contract: exit code 2 + stderr, or `{"decision":"block","reason":…}` on stdout).
- **Task 5:** `agent/skills.ts` `buildCommandInfo`/`skillPlugins` re-sources autocomplete from the real `~/.claude/skills`, `~/.claude/plugins`, and project `.claude/` dirs; the `onSessionCommands` callback path into the supervisor is unchanged.
- **Task 6:** acceptance grep: `grep -rn "createSdkMcpServer" src` → no hits; existing handler tests (they call `*Tools(deps)` directly) pass untouched.

**Phase acceptance (design §5.5):** team/planning tools invocable by CC sessions via MCP; goal stop-hook fires and blocks an unmet goal; skill autocomplete lists real `~/.claude` skills.
