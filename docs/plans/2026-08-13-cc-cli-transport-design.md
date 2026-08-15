# CC CLI Transport — drive sessions through the Claude Code CLI, not the Agent SDK

- **Status:** Draft · **Owner:** stonelyd · **Branch:** `cc-cli-transport`
- **Created:** 2026-08-13 · **Supersedes/extends:** replaces the Agent SDK integration described in `anvil-native-architecture.md` §2/§6; extends `2026-08-01-stable-update-service.md` with a sibling updater for the CC CLI.

## 1. Objective & non-goals

Anvil sessions become **genuine Claude Code sessions**: the daemon spawns the `claude` CLI directly (headless stream-json) instead of driving it through `@anthropic-ai/claude-agent-sdk`. A session started from a phone loads the user's real `~/.claude` config — settings, CLAUDE.md, skills, plugins, hooks, MCP servers — behaves byte-for-byte like terminal Claude Code, lands its transcript in `~/.claude/projects`, and can be `--resume`d from a real terminal. New Claude Code features appear in the Anvil UI the day the CLI ships them (degraded rendering at worst), and the CLI version is managed from any device via an in-app updater with rollback — mirroring the daemon's own self-updater.

**Non-goals:**
- **No protocol redesign.** The daemon↔client wire protocol (`anvild/protocol.ts`) stays compatible except for the enumerated deltas in §4.7. Web/Android/Apple clients keep working with minimal changes.
- **No SDK compatibility layer.** The Agent SDK dependency is deleted, not abstracted behind an interface that supports both. One transport.
- **No re-implementation of CC's permission engine.** CC's own config stack decides *when* to ask; Anvil only supplies the *dialog surface*. The daemon-side danger list and autonomy engine are removed (interview decision: fully CC-native).
- **No migration tooling.** Fresh-start deployment (interview decision); pre-fork event logs and session state are not carried over.
- **No new features beyond the transport swap + CC updater.** Parity first.

## 2. Context

Upstream Anvil (`gte619n/anvil`) drives Claude Code through the Agent SDK and deliberately isolates sessions from ambient CC config (`settingSources: []` — "the daemon is the authority"). That design permanently lags the CLI: every new CC capability (skills, plugins, new tools, new message types) needs SDK support *and* Anvil integration before users see it. This fork inverts the philosophy: **the CLI is the product; Anvil is a thin multi-device projection of real CC sessions.**

Key facts that shape the design:
- The Agent SDK is itself a wrapper that spawns the CC CLI and speaks JSON over stdio. The message shapes Anvil already maps (`agent/map.ts`) are the CLI's `--output-format stream-json` shapes. `map.ts` is explicitly documented as "the SDK-drift containment point" with offline fixture tests — it is the designed retarget seam.
- `PermissionBroker` (`agent/permissions.ts`) and `QuestionBroker` (`agent/questions.ts`) are transport-agnostic promise parks resolved by `permission.respond` / question answers from any device. They survive unchanged; only the CC-facing side changes.
- Decisions from the 2026-08-13 interview: public fork under `Seiraiyu/anvil` tracking upstream (license gap accepted; ask upstream for a license in parallel); **full parity** scope; **fully CC-native** config authority; **process-per-turn** execution; **managed side-by-side CC installs** with manual update + rollback; **defer to CC** for auth (delete the subscription-only guard); **fresh start**; **Linux + macOS co-equal** from day one.

## 3. Inputs & scope

- **In scope (files/modules/systems):**
  - `anvild/src/agent/**` — the entire SDK seam: `driver.ts`, `map.ts`, `query.ts`, `cli.ts`, `permissions.ts`, `questions.ts`, `input-queue.ts`, `danger-list.ts`, `pipeline-guard.ts`, `default-tools.ts`, `team-tools.ts`, `member-tools.ts`, `planning-tools.ts`, `goal.ts`, `skills.ts`, `env.ts`, `models.ts`, `model-roster.ts`, `model-catalog.ts`
  - `anvild/src/integrations/autopilot.ts`, `anvild/src/pipeline/**`, `anvild/src/agent/icon.ts` (SDK `query()` call sites — six total incl. `pickIcon`)
  - `anvild/src/auth/guard.ts`, `auth/degrade.ts` (API-key rejection — deleted per interview)
  - `anvild/src/session/**`, `anvild/src/server/**` (status mapping, protocol deltas)
  - New: `anvild/src/cc/**` (CC install manager, turn runner, transcript reconciler, permission MCP server)
  - `anvild/protocol.ts` (enumerated deltas only), web client surfaces that render autonomy/model/update UI
  - `anvild/package.json` (remove `@anthropic-ai/claude-agent-sdk`)
- **Out of bounds (must not modify):**
  - Render pipeline (`src/render/**`), event log (`src/eventlog/**`), fleet/pairing/push/identity (`src/server/*` except status/protocol touch points), native shells except where the web client changes leak through, terminal/PTY subsystem (reused as-is for attach).
  - Upstream history: the fork stays merge-able; no history rewrites on `main`.
- **Available inputs/tools/data:** CC CLI headless docs (`-p`, `--output-format stream-json`, `--input-format stream-json`, `--resume`, `--permission-mode`, `--permission-prompt-tool`, `--mcp-config`, `--settings`, `--model`, `--include-partial-messages`); official CC installer (versioned installs); existing map fixtures in `test/unit/map.test.ts`.
- **Assumptions log:**
  1. *stream-json output shapes match the SDKMessage shapes map.ts already handles* — high confidence (the SDK is a CLI wrapper) · verified by Phase 3 golden recordings · unconfirmed until then.
  2. *`--permission-prompt-tool` fires for every ask CC's config doesn't auto-resolve, and its allow/deny + updatedInput response is honored in `-p` mode* — documented behavior · verified by Phase 4 spike.
  3. *AskUserQuestion in headless mode routes through the permission prompt tool (answers injected via `updatedInput`)* — **medium confidence; Phase 4 spike is the gate.** Fallback: a daemon-injected PreToolUse hook that parks the question and returns the answer.
  4. *The official installer supports installing a pinned version to a caller-chosen directory* — verified by Phase 2 spike; fallback is downloading the platform binary directly (same artifacts the installer fetches).
  5. *Closing stdin after one `stream-json` user message makes `-p` process exactly one turn then exit* — documented `-p` semantics · verified in Phase 3.

## 4. Design

### 4.1 The one big change

```
BEFORE  driver.ts ──(SDK query(), long-lived, callbacks)──► bundled CC
AFTER   turn-runner ──(spawn ~/.anvil/cc/current/claude -p per turn, stream-json)──► managed CC
```

One session = one conversation + one worktree (unchanged). A **turn** = one spawned CC process:

```
~/.anvil/cc/current/claude -p \
  --output-format stream-json --include-partial-messages --verbose \
  --input-format stream-json \
  --model <model> \
  --permission-mode <mode> \
  --permission-prompt-tool mcp__anvild__approve \
  --mcp-config <session>.mcp.json \
  [--resume <claudeSessionId>] \
  [--settings <session-overlay>.json]
```

The daemon writes exactly one `user` message (text + attachment content blocks) to stdin and closes it; CC runs the full agentic turn, emits stream-json on stdout, and exits. `claudeSessionId` is captured from the first turn's `system/init` message (field already exists in the session model). Next turn respawns with `--resume`.

**Consequences bought by process-per-turn:** interrupt = SIGINT the process group (escalate SIGKILL after 5s) and `--resume` next turn — no control protocol anywhere; mid-conversation model switch = a flag on the next spawn; CC updates need zero drain/restart coordination; crash recovery and interrupt share one code path. Cost: ~1–2s spawn latency per turn, accepted in the interview.

### 4.2 New module map (`anvild/src/cc/`)

| File | Responsibility | Mirrors |
|---|---|---|
| `cc/install.ts` | Versioned installs under `~/.anvil/cc/versions/<v>/`, `current`/`previous` symlinks with atomic flip, injectable downloader, version inventory | net-new store (daemon self-updater is git-in-place); atomic-flip precedent is `web/build.ts` `dist.next`→rename |
| `cc/update.ts` | Update orchestration: check latest, download, **smoke test**, flip, rollback; single-writer state file + in-flight guard | `stable-update-service` transferables: `CommandRunner` injection, phase machine, frozen-contract test |
| `cc/smoke.ts` | Post-install gate: spawn candidate binary in a temp dir, one trivial turn, assert `system/init` + `result` parse, permission-tool round-trip | new |
| `cc/turn-runner.ts` | Spawn/supervise one turn's process; stdin write; stdout NDJSON parse → `mapMessage`; exit/signal handling; per-session turn queue (replaces `InputQueue` semantics) | `driver.ts` (replaces) |
| `cc/stream.ts` | Raw stream-json line parser + local `CCMessage` types (vendored shapes; no SDK import) | `map.ts` input types |
| `cc/permission-server.ts` | MCP server exposing `approve` (the `--permission-prompt-tool` target); bridges to existing `PermissionBroker`/`QuestionBroker`; per-session bearer token; served from the daemon's existing HTTP listener on localhost | `permissions.ts` hook side (replaces) |
| `cc/mcp-config.ts` | Writes each session's `.mcp.json`: the permission server + Anvil tool servers (§4.5) | new |
| `cc/reconcile.ts` | Transcript reconciler: read `~/.claude/projects/<slug>/<id>.jsonl`, diff against event log by message uuid, backfill gaps (crash, PTY-attach turns) | new |
| `cc/oneshot.ts` | `runAgentQuery` replacement for pipeline/autopilot/branch-kind: spawn `-p` with plan-mode/env variants, return `{text, plan}` | `query.ts` (replaces) |

`agent/map.ts` survives with its input type changed from `SDKMessage` to the vendored `CCMessage` and a **generic fallback**: any unrecognized message or content-block type becomes a `fallback.card` event carrying pretty-printed JSON (§4.7 delta 3) instead of being dropped. This is the "new CC features appear day one" mechanism.

### 4.3 Config authority: fully CC-native

- No `settingSources` suppression — sessions load user/project settings, CLAUDE.md, skills, plugins, hooks, and the user's own MCP servers exactly like terminal CC.
- `agent/danger-list.ts`, the autonomy engine in `permissions.ts`, and `auth/guard.ts` + `auth/degrade.ts` (API-key rejection) are **deleted**. The daemon surfaces which auth CC is using (from `system/init`) but never blocks.
- Anvil's `autonomy` field is replaced by CC's permission modes: `default` · `acceptEdits` · `plan` · `bypassPermissions` (§4.7 delta 1). The client picker maps 1:1 to `--permission-mode`.
- Anvil-feature hooks that upstream registered as SDK callbacks (goal progress `Stop` hook in `agent/goal.ts`; pipeline guard, §4.6) become CC hooks injected via a per-session `--settings` overlay file whose hook commands call back into the daemon over localhost HTTP. The overlay *adds* Anvil feature hooks; it never overrides user config.
- Skills/command autocomplete (`agent/skills.ts`) re-sources from the user's real `~/.claude` skills/plugins directories instead of daemon-local plugin config.

### 4.4 Permissions & questions

CC's permission engine evaluates every tool call against the user's real settings. Only when it would prompt does it call the daemon's MCP `approve` tool, which:
1. Creates a `requestId`, parks in `PermissionBroker` (unchanged), fans a `permission.request` event to all devices + push notification.
2. First `permission.respond` wins (unchanged protocol), returns `{behavior: allow|deny, updatedInput?}` to CC.
3. Holds indefinitely — no timeout-deny (pocket-phone is the product). `session.reset` still force-resolves wedged prompts.

`AskUserQuestion` routes through the same channel per Assumption 3: the approve tool recognizes the tool name, renders the existing question card via `QuestionBroker`, and returns the chosen answers as `updatedInput`. The Phase 4 spike validates this before the old path is deleted.

### 4.5 Anvil tools (team/planning/default) as real MCP servers

Upstream's in-process `createSdkMcpServer` tools (`default-tools.ts`, `team-tools.ts`, `member-tools.ts`, `planning-tools.ts`) become one daemon-hosted MCP endpoint (streamable HTTP on localhost, per-session bearer) registered in the session's `.mcp.json`. Tool implementations are unchanged; only registration moves. Tool names keep their existing `mcp__anvil__*` shape so transcripts stay legible.

### 4.6 One-shot paths: pipeline, autopilot, branch-kind

`cc/oneshot.ts` replaces `runAgentQuery`: spawn `-p` (no resume), `--permission-mode plan` for `readonly`, env from `buildAgentEnv` unchanged — the OpenRouter/GLM "Anthropic skin" profiles pass through as env vars to the child exactly as the SDK passed them, so dual-model pipeline parity is env-only. `ExitPlanMode` plan capture reads the same tool_use block from stream-json.

**Deliberate exception to "fully CC-native":** `pipeline-guard.ts` ([SEC-H4]) is retained for unattended pipeline runs — converted to a CC PreToolUse hook in the pipeline's settings overlay. Rationale: it gates a *third-party model* (GLM) running with write tools and no human present; that is a security control on unattended automation, not part of the interactive-session config-authority decision. Interactive sessions get no daemon gate. *(Signed off 2026-08-13: daemon-injected hooks are acceptable wherever needed, provided they are real CC hooks — settings-overlay hook commands — never SDK callbacks.)*

### 4.7 Protocol deltas (exhaustive)

1. **`autonomy` → `permissionMode`**: values `default | acceptEdits | plan | bypassPermissions`. Client picker relabeled. (Breaking; fresh start makes this free.)
2. **`TurnUsage`/rate-limit gauge**: sourced from the `result` message's usage/`rate_limits`/context fields — same data, new extraction; wire shape unchanged.
3. **New event `fallback.card`**: `{ccType: string, json: string (pretty-printed, size-capped)}` rendered by clients as a collapsed generic card. Additive.
4. **New REST surface for the CC updater**: `/api/cc/v1/{status,check,apply,rollback}` + a `cc-update` capability flag. Additive; REST (not WS) and client status-polling (not push) deliberately mirror the daemon-update precedent — a version-skewed daemon rejects versioned WS frames including the update that would repair the skew (`protocol.ts:57-59`), and no progress-push mechanism exists in the update subsystem today.
5. **`session.status` unchanged** (`idle | thinking | running_tool | awaiting_permission | awaiting_question | error | exited`) — now derived in `turn-runner` from stream events + process lifecycle. `exited` gains meaning "turn process gone + not resumable".

### 4.8 CC install & update flow

`~/.anvil/cc/<version>/` per version, `current` + `previous` symlinks. Update (from any device): resolve latest (or pinned target) → download via official installer into the versioned dir → `cc/smoke.ts` gate → atomically flip `current` (in-flight turns keep their already-spawned binary; next turn picks up the new one) → emit changelog event. Failure at any step leaves `current` untouched; `cc.rollback` flips back to `previous`. The daemon refuses to start sessions only when *no* healthy install exists (first-run bootstrap downloads one).

### 4.9 Transcript reconciler & terminal attach

Disk is truth: `~/.claude/projects/<project-slug>/<claudeSessionId>.jsonl` is the authoritative record; stdout stream-json is the live view. Reconciler runs (a) after any abnormal turn end, (b) after PTY terminal detach. PTY attach (existing side-panel terminal) = only from `idle`: daemon marks the session `attached`, spawns `claude --resume <id>` in the PTY, blocks headless turns; on detach, reconciler backfills TUI turns into the event log (rendered through the normal markdown pipeline), session returns to `idle`.

## 5. Deliverables & phases

**Phase tracking table** (statuses maintained as work proceeds):

| Phase | Description | Status | Tested | Pushed |
|-------|-------------|--------|--------|--------|
| 1 | Repo baseline: fork CI green, SDK usage inventory doc, vendored `CCMessage` types + golden stream-json recordings | pending | no | no |
| 2 | CC install manager: versioned installs, smoke gate, update/rollback, bootstrap; REST surface + minimal client UI | pending | no | no |
| 3 | Turn runner + retargeted `map.ts` with fallback card: core sessions CLI-direct (create/converse/interrupt/resume/model-switch) behind a daemon flag | pending | no | no |
| 4 | Permission MCP server + AskUserQuestion spike; `permissionMode` protocol delta; delete danger list/autonomy/auth guard | pending | no | no |
| 5 | Anvil tool MCP servers + settings-overlay hooks (goal stop-hook) + skills autocomplete re-source | pending | no | no |
| 6 | Transcript reconciler + PTY attach handoff | pending | no | no |
| 7 | One-shot conversion: `cc/oneshot.ts`, autopilot, pipeline (+ guard as CC hook), branch-kind; delete SDK dependency | pending | no | no |
| 8 | Full-parity sweep: fleet, integrations, web/Android/Apple UI deltas; flag flip to CLI-direct by default | pending | no | no |
| 9 | Platform hardening: Linux/systemd + macOS/LaunchAgent smoke on real devices; docs; release | pending | no | no |

Each phase's acceptance (functional-test-encodable):
1. Fork builds + upstream tests pass; `bun test` green; golden recordings replay through vendored types without `unknown` fallbacks on core shapes.
2. On a machine with no CC: bootstrap installs; update to a newer version flips symlink only after smoke passes; induced smoke failure leaves `current` untouched; rollback restores `previous`.
3. From the web client: create session → converse with streaming deltas → interrupt mid-tool → next turn resumes with context intact → switch model mid-conversation → session resumable via `claude --resume` in a terminal.
4. A tool call your real CC settings would prompt for raises a dialog on a second device; answering there unblocks the turn; AskUserQuestion renders as the existing question card; a settings-allowlisted call produces **no** dialog.
5. Team/planning tools invocable by CC sessions via MCP; goal stop-hook fires; skill autocomplete lists real `~/.claude` skills.
6. Kill -9 the daemon mid-turn → restart → event log heals from transcript; a turn taken in the attached PTY appears in the client history after detach.
7. Autopilot run and pipeline phase complete on CLI-direct with GLM env profile; `@anthropic-ai/claude-agent-sdk` absent from the lockfile.
8. All upstream-parity features exercised in the fork's existing test suites; SDK flag removed.
9. Fresh install on Linux and macOS via `service.sh` reaches a working session on both.

## 6. Constraints

- **Trust model unchanged:** Tailscale is the perimeter; the permission/tool MCP endpoints bind localhost with per-session bearers (they exist so the *child CC process* can call the daemon, not devices).
- **Compatibility:** protocol deltas limited to §4.7; native shells must run against the new daemon with only web-client changes.
- **No undocumented CC surface.** Only documented flags/behaviors; anything discovered to require undocumented behavior is a design change, not a workaround.
- **Upstream merge-ability:** changes outside `src/agent/` + `src/cc/` kept minimal and mechanical to keep future `upstream/main` merges tractable.
- **Billing:** whatever the machine's CC auth is (interview decision). No metered-billing guard.
- **Platforms:** Linux (systemd/WSL2) and macOS (LaunchAgent) both green each phase.

## 7. Edge cases & failure modes

| Scenario | Expected behavior | Covered by |
|---|---|---|
| Daemon crash mid-turn | Child CC keeps running or dies with process group; on restart, reconciler backfills from transcript; session marked `idle`/`error`, next turn resumes | Phase 6 acceptance |
| Turn process exits nonzero (auth expired, OOM) | `error` event with stderr tail; one automatic resume-retry; then surfaced | Phase 3 tests |
| `--resume` rejected (deleted/foreign session) | Existing `isResumeRejectedError` path: friendly "started fresh context", new `claudeSessionId` | Phase 3 tests |
| Kill during `awaiting_permission` | Broker prompt force-resolved as denied; turn interrupted; question not re-asked on resume — UI shows "interrupted while awaiting" | Phase 4 tests |
| CC update while turns in flight | In-flight turns finish on old binary (open fd); no coordination | Phase 2 design, Phase 3 test |
| Smoke passes but new CC breaks a real flow | `cc.rollback` from any device; golden contract suite re-runnable on demand against `current` | Phase 2 acceptance |
| Unknown stream-json message/block type | `fallback.card` event, size-capped; never dropped, never crashes the parser | Phase 3 golden tests |
| Oversized/garbled NDJSON line | Line skipped with `parser.warn` event + logged raw sample; turn continues | Phase 3 tests |
| Two devices answer one prompt | First `permission.respond` wins (existing broker semantics); second gets stale-request no-op | existing broker tests |
| PTY attach requested mid-turn | Rejected: attach only from `idle` | Phase 6 tests |
| User's own CC hooks/MCP servers misbehave (hang, spam) | Same blast radius as terminal CC — Anvil does not sandbox user config; turn interrupt remains available | N/A — accepted by fully-CC-native decision |
| Gamed-spec case | "Parity" satisfied by flag-off SDK path lingering → Phase 7/8 explicitly delete the dependency and flag; acceptance greps the lockfile | Phase 7/8 acceptance |

## 8. Testing & verification

- **Unit (offline, CI):** retargeted `map.test.ts` fixtures from **golden stream-json recordings** checked in at Phase 1 (recorded from the real CLI); turn-runner state machine with a fake child process; install manager with a fake downloader.
- **Contract suite (on-device, on-demand + every update):** spawns the *real* `current` binary — init/assistant/result shape assertions, permission-tool round trip, resume, interrupt. This is `cc/smoke.ts`'s longer sibling; CI runs it only where CC auth exists (self-hosted runner), else unit-only.
- **Existing suites:** upstream `bun test` + web typecheck stay green every phase.
- **Done-gate:** each phase's acceptance row demonstrated before its table row flips to `Tested: yes`.

## 9. Open questions / spikes (tracked, none block Phase 1–2)

1. AskUserQuestion-via-permission-tool in `-p` mode (Assumption 3) — Phase 4 spike; fallback documented in §4.4.
2. Official installer's pinned-version + custom-dir contract (Assumption 4) — Phase 2 spike.
3. Whether `--include-partial-messages` deltas cover thinking blocks equivalently to the SDK's `stream_event` — **ANSWERED 2026-08-13** by the Phase 1 golden recordings (cc 2.1.231): yes. Thinking arrives as `stream_event`s — `content_block_start` of type `thinking`, then `thinking_delta` + `signature_delta` deltas; text as `text_delta`; tool input as `input_json_delta`. Two reconciliations found while recording: (a) the CLI also emits a top-level `rate_limit_event` on every API request — vendored as KNOWN in `cc/stream.ts` (usage display fodder, ignorable until then); (b) with user setting sources loaded, `system/hook_started`/`hook_response` lines precede `system/init`, so the recorder passes `--setting-sources "" --strict-mcp-config` to match the daemon's `settingSources: []` — but the transport must NOT assume init is the first line on streams where hooks are configured.
4. Upstream license: ask `gte619n` for MIT/Apache (parallel, non-blocking; fork proceeds per interview decision).
