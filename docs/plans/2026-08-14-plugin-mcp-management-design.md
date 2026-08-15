# Plugin & MCP management from Anvil — design

> **SUPERSEDED (2026-08-15)** by [`2026-08-15-claude-code-config-management-design.md`](2026-08-15-claude-code-config-management-design.md).
> Scope grew from two domains to four (plugins, MCP, auto-mode config, memory). Nothing here was executed.
> Two findings below are also **wrong** and corrected in the successor §3: the §10 non-goal claiming
> worktree-derived memory namespaces (memory is repo-keyed, not cwd-keyed), and the absence of
> auto-mode config as a managed domain (CC shipped `auto` on 2026-08-14).

**Status:** approved approach, pending spec review
**Date:** 2026-08-14
**Depends on:** cc-cli-transport plans 1–8 (merged), plan 9 (platform hardening) runs first

## 1. Goal

Manage Claude Code **plugins** and **MCP servers** from Anvil's UI, on each machine in the fleet,
with a diff-based sync between boxes. No terminal required at any point.

Concretely, from Settings you can: see what's installed on each server, install from a marketplace,
enable/disable/update/uninstall, add and remove MCP servers, and reconcile two machines by reviewing
a diff and ticking the changes you want.

## 2. What already works (measured, not assumed)

This matters because it shrinks the problem substantially. All of the following was verified on
2026-08-14 against a live daemon and the real CLI, not inferred from code:

- **A daemon-spawned session already loads global config.** An Anvil session reports the same **79
  slash commands** as a terminal session, including the user's skills (`funnel`, `superwisdom:*`,
  `seiraiyu-skills:*`, `episodic-memory:*`).
- **MCP servers already connect.** `/mcp` inside an Anvil session reports `2 connected`, and
  `/context` lists the episodic-memory MCP tools (`__search`, `__read`) — i.e. "search past
  conversations" already works today.
- **Custom agents, skills, and plugin-provided MCP servers already load.**
- **Most slash commands already pass through.** `/model`, `/context`, `/mcp`, `/cost`, `/config`,
  `/usage`, `/recap`, `/insights`, `/effort`, `/color`, `/init` all return real CLI output today,
  because anything not in `isDaemonHandledCommand` is forwarded verbatim to the CLI.

**So the gap is not "global resources" — it is management.** There is no way to install a plugin or
add an MCP server from Anvil, because those are interactive (`/plugin` refuses headlessly with
`"/plugin isn't available in this environment"`) and Anvil never calls the non-interactive
equivalents.

### 2.1 The CLI surface we build on

Claude Code exposes non-interactive subcommands that do exactly this work:

```
claude plugin list [--json] [--available --json]
claude plugin install|uninstall|enable|disable|update|details <plugin>
claude plugin marketplace add|list|remove|update
claude mcp add|add-json|list|get|remove [options] <name> …
```

`claude plugin list --json` returns structured records:

```json
{ "id": "episodic-memory@superpowers-marketplace", "version": "1.0.15", "scope": "user",
  "enabled": true, "installPath": "…", "installedAt": "…", "lastUpdated": "…",
  "mcpServers": { "episodic-memory": { "command": "node", "args": ["…"], "env": {} } } }
```

**Asymmetry to plan around:** `claude mcp list` / `mcp get` have **no `--json`** — text only, and
they perform health checks (slow). See §4.3.

### 2.2 The `init` message is a free structured read path

Every turn's `init` line — which the daemon already parses — carries:

| Field | Contents |
|---|---|
| `plugins` | `[{name, path, source, version}]` |
| `mcp_servers` | `[{name, status}]` — `connected` / `needs-auth` |
| `skills`, `agents`, `slash_commands` | already consumed for the `/` menu |
| `terminal_slash_commands` | commands that only work in a real terminal (`doctor`, `color`) |
| `memory_paths` | `{auto: "~/.claude/projects/<cwd-slug>/memory/"}` |
| `claude_code_version`, `model`, `permissionMode`, `cwd` | session facts |

This gives **live status for free on every turn**, with no extra process spawn.

## 3. Constraints

1. **No PTY.** A terminal-based flow forecloses the phone, which is the product's primary target
   even though phone UI is out of scope for this design.
2. **Per-machine reality.** Plugins and MCP live in `~/.claude` on whichever box runs the daemon.
   Anvil is a fleet; each daemon manages only its own box.
3. **Never reimplement Claude Code's logic.** Marketplace resolution, dependency pruning, cache
   layout, and version pinning stay the CLI's job. Anvil drives the CLI; it does not edit
   `~/.claude` config files directly.
4. **Additive protocol.** New capability + new commands only. No changes to existing envelopes, so
   `PROTOCOL_VERSION` stays at 5.
5. **Older daemons must show no dead controls** — same capability-gating discipline as `cc-update`.

## 4. Architecture

### 4.1 Shape

```
web/src/plugins.ts ──WS──> dispatch ──> supervisor.pluginService
                                              │
                                              ├── reads:  init.plugins / init.mcp_servers   (free, per-turn)
                                              │           claude plugin list --json          (on demand)
                                              └── writes: claude plugin install|enable|…
                                                          claude mcp add|remove
```

A new domain service `src/session/plugin-service.ts` follows the established P7 pattern: an injected
`PluginServiceDeps` interface documenting exactly what supervisor state it touches, plus a guard test
in `test/unit/`. The supervisor delegates; it does not grow.

### 4.2 The CC-CLI adapter

`src/cc/plugins.ts` — a thin, typed wrapper. One exported function per operation, each shelling out
via the existing `spawnInGroup` helper with `buildAgentEnv()` (so the §3 env allow-list and account
selection are inherited unchanged), a hard timeout, and JSON parsing where available.

Deliberately **not** a generic "run any claude subcommand" endpoint: the allowed operations are an
explicit closed set, so a compromised client cannot turn this into arbitrary command execution.

### 4.3 Reading MCP state without `--json`

Three sources, in preference order:

1. **`init.mcp_servers`** — structured `{name, status}`, free every turn. This is the display source
   for *status*.
2. **`claude plugin list --json` → `mcpServers`** — plugin-provided servers, structured.
3. **`claude mcp list` text** — only for user-added servers not covered above. Parsed by a tolerant
   line parser (`name: target - status`) that **degrades to "unparsed, shown raw" rather than
   throwing**, with a contract test pinning the current format. Format drift is a known maintenance
   point, recorded here so it is a conscious cost rather than a surprise.

Writes always use `claude mcp add|add-json|remove`, which are stable and non-interactive.

### 4.4 Sync (diff, per-item apply)

Sync never mutates implicitly. The flow is:

1. User picks **source** and **target** server.
2. Daemon asks each for its installed set (`claude plugin list --json`, plus MCP per §4.3).
3. Hub computes a diff: `to-install` (on source, missing on target), `to-remove` (on target, absent
   from source), `version-differs`.
4. UI renders the diff with a checkbox per item. **Nothing is pre-selected for removal.**
5. User applies; the **target daemon** executes only the ticked operations, reporting per-item
   results.

Per-box uniqueness is preserved by construction: a member keeps whatever the user did not tick.

**Secrets:** per the interview decision, MCP entries sync *including* their secret material, under
the same trust model as the existing account roster (Tailscale-only boundary, `0600` on disk,
hub-orchestrated). This is recorded as a deliberate decision, not an oversight: it widens the blast
radius of a compromised member to every synced credential. Revisit if the fleet ever spans a machine
the user does not fully control.

### 4.5 When changes take effect

Anvil spawns a **fresh `claude` per turn**, so an install/enable lands on the **next turn** with no
restart plumbing. The `init` of that turn republishes `slash_commands`, so a newly installed
plugin's commands appear in the composer's `/` menu automatically via the existing
`onSessionCommands` path. Nothing extra to build.

A session mid-turn is unaffected. The UI says "applies to the next turn" rather than implying live
reload.

## 5. Protocol & API surface

Additive only.

- **Capability:** `"plugins"` added to `src/server/identity.ts`. Clients gate the whole UI on it, so
  an older daemon renders nothing (the `ccCardRowHtml` pattern).
- **REST**, alongside the existing frozen `/api/cc/v1`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cc/v1/plugins` | installed plugins (`claude plugin list --json`) |
| GET | `/api/cc/v1/plugins/available` | marketplace catalogue (`--available --json`) |
| POST | `/api/cc/v1/plugins/:op` | `install` / `uninstall` / `enable` / `disable` / `update` |
| GET | `/api/cc/v1/marketplaces` | configured marketplaces |
| POST | `/api/cc/v1/marketplaces` | add / remove / update |
| GET | `/api/cc/v1/mcp` | MCP servers + status (§4.3) |
| POST | `/api/cc/v1/mcp` | add / remove |

Long operations (install, update) return immediately with a job id and stream progress over the
existing WS `autopilot.run.progress`-style channel, rather than holding an HTTP request open.

`CC_API_VERSION` is **not** bumped: these are new paths, and §4.8's response shapes are unchanged.

## 6. UI

New Settings tab **Plugins**, mirroring the Environments tab's per-server sectioning:

```
Settings > Plugins
  seiraiyu1 (hub)      127.0.0.1:7701
   • episodic-memory@superpowers  1.0.15  [on]   Disable  Update
   • superwisdom@seiraiyu         1.3.1   [on]   Disable
   [+ Install from marketplace]
   MCP: episodic-memory ✔ connected · Google Drive ✔ · Gmail ⚠ needs-auth   [+ Add server]

  macbook (member)     100.x.y.z:7701
   • episodic-memory@superpowers  1.0.15  [on]   Disable
   [+ Install from marketplace]

  [Sync…]   source: seiraiyu1 → target: macbook
```

Rules:
- Every async button uses the `busy()` helper (the Todoist-Refresh bug from the e2e round).
- Panels repaint through `repaintPreservingInput()` so a broadcast cannot eat a half-typed MCP
  command or header.
- Destructive actions (uninstall, remove server, sync removals) go through `confirmDialog`.
- `needs-auth` MCP servers are surfaced explicitly — that state is invisible today.

## 7. Error handling

| Failure | Behaviour |
|---|---|
| `claude` binary missing on target | Capability still advertised; operation returns a clear "Claude Code not installed on <server>" rather than a spawn stack trace |
| Marketplace unreachable | Surface the CLI's stderr verbatim, truncated; do not invent a message |
| Install fails midway | Report per-item; never claim fleet-wide success on partial failure (the `saveSchedule` bug) |
| `claude mcp list` format drift | Tolerant parser degrades to raw text + a warning row; never throws |
| Op times out | Kill the process group (`killGroup`), report timeout, leave state to be re-read |
| Concurrent ops on one server | Serialised per server with a simple in-flight guard; second request is refused with a clear message (the autopilot re-entrancy bug) |

## 8. Security

- The closed operation set (§4.2) means no arbitrary command execution.
- Plugin installation **is** code execution on the box; it is gated by the Tailscale boundary and the
  existing origin gate, same as every other mutating REST route. Documented in `SECURITY.md`.
- Secrets in MCP configs are never logged and never echoed into WS events; the UI shows names and
  status only, with values write-only.
- Sync is hub-orchestrated and targets only paired members.

## 9. Testing

- **Unit:** the CLI adapter against recorded fixtures (real `claude plugin list --json` output,
  captured like the plan-1 golden recordings); the tolerant `mcp list` parser incl. malformed input.
- **Contract:** `plugins` capability present; response shapes pinned additively; a test asserting an
  older daemon (no capability) renders no controls.
- **Diff:** table-driven cases for install/remove/version-differs, including the "nothing
  pre-selected for removal" rule.
- **Web:** DOM tests for the per-server sections, `busy()` guards, and repaint-preserving-input.
- **Integration:** a fake-`claude` harness (extending `test/helpers/fake-cc.ts`) so install/uninstall
  can be exercised without touching a real `~/.claude`.
- **Live:** one manual pass installing and removing a real plugin on the hub, and one sync between
  two boxes, recorded in the phase table.

**No test may mutate the developer's real `~/.claude`.** All automated tests point `HOME` at a temp
dir.

## 10. Non-goals

- **Auto-memory across worktrees.** Explicitly deferred (interview decision). Recorded finding:
  Anvil's worktree sessions get a cwd-derived memory namespace
  (`memory_paths.auto` → `~/.claude/projects/<worktree-slug>/memory/`), so they start empty and their
  memory is orphaned when the worktree is deleted. Confirmed on disk. Worth its own design later.
- **Phone-optimised UI.** Desktop-first; the architecture deliberately keeps the phone possible by
  avoiding a TTY.
- **Passthrough for the remaining TUI-only commands** (`/plugin`, `/help`, `/status`, `/login`).
  Once this ships, `/plugin`'s job is done natively; the rest are informational.
- **A generic "run any slash command" bridge.**

## 11. Phases

| Phase | Description | Status | Tested | Pushed |
|-------|-------------|--------|--------|--------|
| 1 | CC-CLI adapter (`src/cc/plugins.ts`): typed wrappers over `claude plugin list/install/uninstall/enable/disable/update` + fixtures | pending | no | no |
| 2 | `plugin-service.ts` domain service + `plugins` capability + REST reads (`/plugins`, `/plugins/available`, `/marketplaces`) | pending | no | no |
| 3 | REST writes + job/progress streaming for long installs; per-server serialisation guard | pending | no | no |
| 4 | MCP read path (§4.3: `init.mcp_servers` + tolerant `mcp list` parser) and `mcp add/remove` writes | pending | no | no |
| 5 | Web: Settings → Plugins tab, per-server sections, install/enable/disable/update/uninstall, MCP list + add | pending | no | no |
| 6 | Sync: diff computation, per-item selection UI, target-side apply with per-item results | pending | no | no |
| 7 | Docs (`ARCHITECTURE.md`, `SECURITY.md` note), live pass on hub + one member, recorded here | pending | no | no |

## 12. Open questions

1. Does `claude plugin install` prompt for confirmation in any path? If so the adapter needs a
   non-interactive flag or stdin handling — to be verified in phase 1 against the real binary.
2. Marketplace catalogues can be large; `--available --json` may need pagination or client-side
   filtering in the UI. Sized in phase 2.
3. Whether `enable`/`disable` are per-scope (user vs project) in a way the UI must expose — the JSON
   carries `scope`, so the UI should at minimum display it.
