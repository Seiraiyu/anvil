# Auto mode — restoring the danger backstop for interactive sessions

**Goal:** bring back the behavior the old `mostly-autonomous` autonomy policy provided — *run unattended, but stop and ask a human before something genuinely destructive* — without re-introducing the daemon-side permission engine that cc-plan-4 deliberately deleted.
**Architecture:** a session-scoped `PreToolUse` hook (rendered from the same danger table `agent/pipeline-guard.ts` already owns) returns `allow` for clean calls and `ask` for danger-list hits. CC's engine escalates the `ask` to `--permission-prompt-tool mcp__anvild__approve`, which is already wired — so the existing `PermissionBroker` → `permission.request` card → multi-device resolution path is reused verbatim. Design §4.4, §4.7 delta 1 (this is the follow-up that plan 4 left implicit).

**GATES:** **Task 1 is a live spike and gates every other task.** The whole design rests on one unverified claim — that a hook's `ask` verdict reaches the permission-prompt tool in `-p` mode. If it does not, Task 1's fallback changes the transport for Tasks 3/5 (but not the product behavior).

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | SPIKE (LIVE): does a PreToolUse `ask` reach `--permission-prompt-tool` under `-p`? | pending | no | no |
| 2 | Extract the danger table from `pipeline-guard.ts` into a shared module with two renderers (deny / ask) | pending | no | no |
| 3 | Session settings overlay: render + install the interactive guard hook in the turn-runner spawn | pending | no | no |
| 4 | Protocol: additive `dangerBackstop?: boolean` + `danger-backstop` capability | pending | no | no |
| 5 | Supervisor wiring: hook → daemon → `askPermission` → existing card | pending | no | no |
| 6 | Web: backstop toggle in `dialogs.ts` + session settings; default ON | pending | no | no |
| 7 | Tests: verdict equivalence, ask-path integration, kill-during-awaiting | pending | no | no |
| 8 | Docs: `SECURITY.md` + `ARCHITECTURE.md` §6.6 rewrite | pending | no | no |

## Why this exists (the gap, stated precisely)

`3084128` (*autonomy → CC-native permissionMode*) replaced a four-value daemon-owned dial with CC's four native `--permission-mode` values. The old dial:

| Policy | Behavior |
|---|---|
| `mostly-autonomous` *(default)* | auto-allow everything **except** the danger list → prompt on those |
| `allowlist` | auto-allow read-only tools; prompt for writes/net |
| `prompt-all` | prompt on every tool |
| `bypass` | never prompt, skip even the danger list |

There is no CC-native cell for the first row. The migration in `web/src/outbox.ts` says so directly:

```ts
"mostly-autonomous": "bypassPermissions", // the closest behavioral match (rarely prompted)
```

and `web/src/dialogs.ts:283` sets `DEFAULT_PERMISSION_MODE = "bypassPermissions"` to "preserve today's default behavior."

**So `mostly-autonomous` was split, not replaced.** The danger table survived — into `agent/pipeline-guard.ts` — but it is wired only into `runCcQuery` one-shots (pipeline, autopilot, and since the #195–#199 merge, loop laps), where it emits a hard **deny** because no human is present. Interactive sessions inherited the auto-allow half and lost the floor: the default session today spawns `--permission-mode bypassPermissions` with nothing between the model and `rm -rf`, a force-push, or a read of `~/.ssh/id_rsa`.

This plan restores the floor for interactive sessions. It does **not** restore `AutonomyPolicy`.

## Fixed decisions and known facts

### The design principle is not violated

Design §13 states: *"No re-implementation of CC's permission engine. CC's own config stack decides when to ask; Anvil only supplies the dialog surface."* That principle killed the four-policy `decide()` function that re-adjudicated **every** tool call. A hook that passes everything through untouched and escalates only danger-table hits is a thin backstop layered on CC's engine, not a replacement for it — CC still decides everything else. Keep it that way: the hook must never return `deny` in interactive mode, and must never `ask` for anything outside the table.

### Verified against the Claude Code hooks reference (2026-08-15)

- `PreToolUse` supports `hookSpecificOutput.permissionDecision` of `"allow" | "deny" | "ask"`; `"ask"` escalates to the user.
- *"Hooks fire regardless of permission mode. They run in `bypassPermissions` mode just as in any other mode, so a hook can still inspect and block tool calls even when the user has disabled the permission system."*

That second fact is what makes the design work: the backstop composes with `bypassPermissions` rather than requiring a mode change, so "rarely prompted" stays true.

### NOT verified — this is Task 1

Whether a hook-originated `ask` is routed to `--permission-prompt-tool` in `-p` mode, or whether it dead-ends (auto-deny / hang) because there is no TTY. The docs say "escalates to the user" without specifying headless behavior. Plan 4's execution notes confirmed the **engine-originated** path live (`test/tools/probe-cc-permission.ts`, cc 2.1.231): the approve tool receives prompt-worthy calls and `AskUserQuestion`, and `allow`/`deny`/`updatedInput` are honored. The hook-originated path is a different code path and has never been probed here.

**Task 1 fallback (if `ask` does not route):** the hook script does the round trip itself. Unlike the one-shot guard — which is deliberately self-contained because it has no session id or bearer — an interactive session **does** have both, and `cc/mcp-config.ts` already mints a per-session bearer. The hook POSTs to the daemon's existing listener, blocks on `askPermission`, and returns the resolved `allow`/`deny` directly. Same product behavior, same card, one extra HTTP hop; Tasks 3 and 5 change shape but not scope. Record the finding as comments in the probe, then amend this doc before executing (rules of the road).

### Shape: a separate field, not a fifth enum value

Add `dangerBackstop?: boolean` alongside `permissionMode` rather than a `mostly-autonomous` value on `PermissionMode`.

The old enum conflated two independent axes: *how much to auto-allow* × *is there a destructive-action floor*. `PermissionMode` is the first axis and should stay 1:1 with `--permission-mode` — that 1:1 mapping is the entire value of delta 1, and adding a value that has no CLI counterpart silently breaks it. The backstop is the second axis, and modelling it separately is strictly more expressive: `acceptEdits` **with** a floor becomes representable, which the old dial could not say.

Default: **ON**. The old default (`mostly-autonomous`) had the floor; today's default (`bypassPermissions`) does not. Defaulting the backstop on restores the original safety posture without changing anyone's permission mode.

### Protocol impact: additive, no version bump

Per [`docs/REQUIREMENTS.md`](../REQUIREMENTS.md) §4 (additive-or-bump), a new **optional** field is additive — `PROTOCOL_VERSION` stays **5**. Sites to touch in `docs/plans/anvil-protocol.ts` (the real file; `anvild/protocol.ts` is a symlink):

- `Session` projection (near `permissionMode` at `:284`) — `dangerBackstop: boolean`
- `session.create` (near `:1181`) — optional, defaults true
- a `session.set_danger_backstop` command, mirroring `SessionSetPermissionModeCmd` (`:1245`) and its union entry (`:1655`)
- autopilot/loop defaults (`:1471`, `:1481`) — unattended paths keep the **deny** guard they already have; do not route those through `ask` (there is no human)
- `SERVER_CAPABILITIES` in `src/server/identity.ts` — add `"danger-backstop"` so an older daemon degrades cleanly and the client can gate the toggle

Wire-type golden regen: `bun test/contract/regen-golden.ts` (note plan 4's finding — the helper lives in `wire-types.ts`; importing a `.test.ts` throws outside the runner).

### Task 2: one table, two renderers

`agent/pipeline-guard.ts` currently owns both the danger table and the unattended semantics. Split it:

- the table + `isDangerous()` move to a shared module
- `pipelineGuardVerdict()` keeps `allow` / **`deny`** (unattended — unchanged, still [SEC-H4])
- a new interactive renderer emits `allow` / **`ask`**

**Hazard:** `renderGuardHookScript()` serializes the regexes into a standalone generated script, and `test/unit/pipeline-guard.test.ts` pins equivalence between the rendered script and `pipelineGuardVerdict()` — the header says *"change verdict logic in BOTH places or the test fails."* With two renderers that becomes three places. Generate both from the one table and extend the equivalence test to cover both renderers.

The table itself (`BASH_PATTERNS`, `SECRET_PATH`, worktree-escape check) transfers as-is; it was written for exactly this purpose and is still the conservative, auditable one-table design the arch doc describes. Worth a review pass for CLI-era gaps (e.g. `gh` destructive subcommands, `docker system prune`) but that is not a blocker — ship parity first.

### Task 3: where the hook gets installed

`cc/turn-runner.ts:~179` builds the spawn args and already threads `...(this.deps.permissionArgs?.() ?? [])`. The one-shot path shows the pattern to copy: `writeGuardOverlay()` in `cc/oneshot.ts` writes `guard-hook.mjs` + a `--settings` overlay declaring `PreToolUse` with `timeout: 3600` (a long tool call must not outlive its gate — an interactive `ask` parked on a human needs at least that, since the broker holds indefinitely by design).

**Do not** clobber the user's own settings: sessions are fully CC-native (design §4.3 — user/project settings, `CLAUDE.md`, skills, plugins, hooks all load). `--settings` must be an overlay that composes with the user's hooks, not a replacement. Verify a user-defined `PreToolUse` hook still fires alongside ours.

### Task 5: reuse, do not rebuild

`askPermission(session, broker, toolName, input)` in `agent/permissions.ts` is the whole daemon-side path and needs no changes: it honors `session.isAlwaysAllowed`, mints the request id, fans the `permission.request` card to every device, and blocks until any device answers. `allow_always` is recorded inside the daemon. `session.reset` force-resolves wedged prompts (`resolveSession`), and plan 4's kill-during-`awaiting_permission` semantics already force-deny parked prompts on interrupt — confirm that still holds when the parked prompt originated from a hook rather than the approve tool.

### Task 7: acceptance

- `rm -rf` in a `bypassPermissions` session parks a `permission.request` card instead of running
- denying it returns a denial to the model and the turn continues coherently
- allowing it runs the command
- a non-dangerous `Bash(ls)` in the same session never prompts (the "rarely prompted" property is the point — a backstop that prompts constantly will be turned off)
- `dangerBackstop: false` restores today's behavior exactly
- unattended one-shots still **deny** (not `ask`) — no regression in `pipeline-guard.test.ts`
- a user's own `PreToolUse` hook still fires with ours installed

## Out of scope

- Restoring `AutonomyPolicy`, `allowlist`, or `prompt-all`. CC's `default` mode covers the prompt-heavy end; the docs also now list a `dontAsk` mode that did not exist when delta 1 was written and may cover `allowlist`'s intent — evaluate separately.
- `LoopAct.permissionMode` (`anvil-protocol.ts:907`). Declared but unread — `loop-service.ts` `runLap` hardcodes `readonly: false`. It was equally unread upstream as `autonomy`. Wiring it up is its own task; note that loop laps are unattended and therefore want the **deny** guard they already inherit from `runCcQuery`, not this `ask` path.
