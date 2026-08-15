# Claude Code config management from Anvil — design

- **Status:** approved approach, pending spec review
- **Date:** 2026-08-15
- **Supersedes:** [`2026-08-14-plugin-mcp-management-design.md`](2026-08-14-plugin-mcp-management-design.md) and its
  22-task plan ([`2026-08-15-plugin-mcp-management-plan.md`](2026-08-15-plugin-mcp-management-plan.md)) — both
  unexecuted; the scope grew from two domains to four.
- **Also supersedes:** the build described in
  [`2026-08-15-auto-mode-danger-backstop.md`](2026-08-15-auto-mode-danger-backstop.md) — see §3.1.
- **Extends:** [`2026-08-12-claude-md-reflection.md`](2026-08-12-claude-md-reflection.md) (the first memory slice, merged)
- **Depends on:** cc-cli-transport plans 1–9 (all merged to `main`)

## 1. Goal

Manage the whole per-machine **Claude Code configuration surface** from Anvil's UI, on each machine in
the fleet, with a diff-based sync between boxes. No terminal required at any point.

Four domains, one surface:

| Domain | Read | Write | Why Anvil |
|---|---|---|---|
| **Plugins** | `claude plugin list --json` | `claude plugin install/uninstall/enable/disable/update` | `/plugin` refuses headlessly |
| **MCP servers** | `init.mcp_servers` + `claude mcp list` | `claude mcp add/add-json/remove` | no non-TUI management path |
| **Auto mode** | `claude auto-mode config` / `defaults` | `autoMode` block in `~/.claude/settings.json` | new in CC v2.1.x; no UI at all |
| **Memory** | read `~/.claude/projects/<repo>/memory/` | edit/delete files; `autoMemoryEnabled` | `/memory` is TUI-only |

## 2. Governing principles

Stated by the owner during the 2026-08-15 interview. They decide most of what follows, so they are
recorded first.

1. **Leverage CC as hard as possible; keep Anvil everywhere else.** Anvil never reimplements
   something Claude Code already does. Marketplace resolution, memory keying, the auto-mode
   classifier, permission adjudication — all stay the CLI's job. Anvil supplies the *surface* and the
   *fleet dimension*.
2. **Anvil never automates a repo decision.** Specifically: Anvil must never write a `.gitignore`
   entry — and, by extension, must not create untracked files in the user's working tree that force a
   commit-or-ignore decision. Anvil exposes knobs; the user turns them.
3. **Sync never mutates implicitly.** Carried forward from the superseded design §4.4. Nothing is
   pre-selected for removal; every applied change is an explicit tick.

## 3. What changed since 2026-08-14

Three findings reshaped this design. All were verified on 2026-08-15 against the live CLI
(**v2.1.233**) and the machine's real `~/.claude`, not inferred.

### 3.1 Claude Code shipped auto mode

On 2026-08-14, `auto` became a first-class permission mode and the built-in default for Pro/Max/Team
plans in the terminal and VS Code. Verified on the installed CLI:

```
--permission-mode <mode>   (choices: "acceptEdits", "auto", "bypassPermissions",
                            "manual", "dontAsk", "plan")
```

Auto mode runs everything, routing tool calls through a classifier that blocks anything irreversible,
destructive, or aimed outside the trusted environment. **This is the `mostly-autonomous` cell that
cc-plan-4 removed** — implemented by Anthropic with a Sonnet-class classifier instead of Anvil's old
regex danger list.

**Consequences:**

- The hook-and-regex backstop designed in `2026-08-15-auto-mode-danger-backstop.md` is obsolete before
  it was built. A regex table is strictly worse than the classifier. That doc's *build* is superseded;
  its *problem statement* (§"Why this exists") remains accurate and is the reason this matters.
- **The spike that gated that plan is no longer needed.** It hinged on whether a hook-originated `ask`
  reaches `--permission-prompt-tool` under `-p` — unverified and risky. Auto mode needs no hook:
  `permissions.ask` rules produce an **engine-originated** prompt, which cc-plan-4 already confirmed
  live routes to `mcp__anvild__approve`. The uncertain path is gone.
- **`claude -p` does not inherit the new default.** The docs are explicit that `-p` and the Agent SDK
  start in `default`. Anvil spawns `-p`, so it must pass `--permission-mode auto` explicitly or gain
  nothing.
- `autoMode` config is a fourth per-machine domain with the same shape as the others.

### 3.2 The worktree-memory finding was a misreading

The superseded design deferred memory on this basis:

> Anvil's worktree sessions get a cwd-derived memory namespace (`memory_paths.auto` →
> `~/.claude/projects/<worktree-slug>/memory/`), so they start empty and their memory is orphaned when
> the worktree is deleted. **Confirmed on disk.**

It is not so. Measured on this machine:

| Namespace | `memory/` | transcripts |
|---|---|---|
| `-home-stonelyd-AnviloverCC-anvild` | **no** | 9,453 |
| `-home-stonelyd-AnviloverCC-plan9-anvild` | **no** | 1,596 |
| `-home-stonelyd-AnviloverCC` | **yes** | 571 |

Across 128 namespaces, 42 contain a `memory/` dir and **zero of them are worktree- or
subdirectory-derived**. `~/.claude/projects/<cwd-slug>/` is *transcript* storage — that is what is
per-cwd. The original finding conflated transcript namespaces with memory namespaces.

The docs confirm the intended behavior: *"The `<project>` path is derived from the git repository, so
all worktrees and subdirectories within the same repo share one auto memory directory."* Memory is
also excluded from the `cleanupPeriodDays` retention sweep.

**So there is no worktree amnesia and no orphaning to fix.** The stated rationale for both the
original deferral and for reopening it is void. What follows is built on the gaps that are real.

### 3.3 The real memory gaps

1. **`/memory` is TUI-only.** No way to browse, audit, or prune what Claude has remembered from a
   phone — the same gap as `/plugin`, which is what justified this design in the first place.
2. **Memory is machine-local, by explicit design.** The docs state: *"Files are not shared across
   machines or cloud environments."* Anvil is a fleet product; this is the one place it can add
   something Anthropic has said it does not do.

## 4. What already works (measured, not assumed)

Carried forward from the superseded design and re-confirmed. This shrinks the problem substantially.

- A daemon-spawned session loads global config: **79 slash commands**, the user's skills, custom
  agents, and plugin-provided MCP servers, identical to a terminal session.
- MCP servers already connect (`/mcp` reports connected; `/context` lists their tools).
- Most slash commands already pass through, because anything outside `isDaemonHandledCommand` is
  forwarded verbatim.
- **The gap is management, not availability.**

### 4.1 The `init` message is a free structured read path

Every turn's `init` line — already parsed by the daemon — carries `plugins`, `mcp_servers`
(`{name, status}`), `skills`, `agents`, `slash_commands`, `memory_paths`, `permissionMode`, and
`claude_code_version`. Live status for free on every turn, with no extra spawn.

`memory_paths.auto` is the authoritative memory location for the session and is **not currently
consumed** by the daemon (grep-verified). Reading it is how the memory UI locates the directory,
rather than Anvil re-deriving the slug — re-derivation would be reimplementing CC logic, violating
principle 1.

## 5. Constraints

1. **No PTY.** A terminal flow forecloses the phone.
2. **Per-machine reality.** Each daemon manages only its own `~/.claude`.
3. **Never reimplement CC's logic** (principle 1). Anvil drives the CLI and reads its reported state;
   it does not compute project slugs, resolve marketplaces, or adjudicate permissions.
4. **Never create untracked files in the user's repo** (principle 2).
5. **Additive protocol.** New capability + new commands only; `PROTOCOL_VERSION` stays **5**.
6. **Older daemons show no dead controls** — capability-gated, as `cc-update` is.

## 6. Architecture

### 6.1 Shape

```
web/src/ccconfig.ts ──WS/REST──> supervisor.ccConfigService
                                        │
                                        ├── plugins   → src/cc/plugins.ts    → claude plugin …
                                        ├── mcp       → src/cc/plugins.ts    → claude mcp …
                                        ├── automode  → src/cc/automode.ts   → claude auto-mode …
                                        └── memory    → src/cc/memory.ts     → fs over memory_paths.auto
```

One domain service `src/session/ccconfig-service.ts` follows the established P7 pattern: an injected
`CcConfigServiceDeps` interface documenting exactly what supervisor state it touches, plus a guard
test in `test/unit/`. The supervisor delegates; it does not grow.

### 6.2 The CC-CLI adapters

Thin typed wrappers, one exported function per operation, each shelling out via `spawnInGroup` with
`buildAgentEnv()` (inheriting the §3 env allow-list and account selection), a hard timeout, and JSON
parsing where available.

Deliberately **not** a generic "run any claude subcommand" endpoint: the allowed operations are an
explicit closed set, so a compromised client cannot escalate to arbitrary command execution.

`claude auto-mode config|defaults|critique|reset` are non-interactive and JSON-emitting — verified
live — so auto mode fits the adapter pattern exactly as plugins do.

### 6.3 Reading MCP state without `--json`

`claude mcp list` / `mcp get` have **no `--json`** and perform slow health checks. Three sources in
preference order:

1. **`init.mcp_servers`** — structured, free every turn. The display source for *status*.
2. **`claude plugin list --json` → `mcpServers`** — plugin-provided servers, structured.
3. **`claude mcp list` text** — only for user-added servers not covered above. A tolerant line parser
   (`name: target - status`) that **degrades to "unparsed, shown raw" rather than throwing**, with a
   contract test pinning the current format. Format drift is a known maintenance cost, recorded here
   deliberately.

### 6.4 Memory: read and write

**Location is read from `init.memory_paths.auto`, never derived.** Anvil does not compute the project
slug (principle 1).

- **Read:** list the directory; `MEMORY.md` is the index, topic files alongside it. Render `MEMORY.md`
  first and prominently, since it is the only file loaded into every session (first 200 lines / 25 KB).
- **Write:** edit and delete files. Anvil writes plain markdown; it never invents structure. When
  editing `MEMORY.md`, the UI surfaces the 200-line / 25 KB budget and warns on approach, because CC
  drops everything past the limit on the next load.
- **Toggle:** `autoMemoryEnabled` in `~/.claude/settings.json`.
- **`autoMemoryDirectory` is surfaced as an editable setting and never set by Anvil.** The user may
  relocate memory (including into a repo, where their own `.gitignore` choice applies); Anvil shows
  the knob and does not turn it. This is principle 2 applied literally. Anvil validates only what CC
  requires — absolute path or `~/`-prefixed — and reports the value CC actually resolved via
  `memory_paths.auto` on the next turn, so a bad value is visibly inert rather than silently wrong.

**Relocation is not automated, and not recommended by the UI.** Moving memory into the working tree
creates an untracked directory the user must then commit or ignore in every project — Anvil imposing a
decision by side effect. CC's default already gives repo-scoped, worktree-shared, retention-exempt
memory (§3.2), so relocation buys nothing for the common case.

### 6.5 Auto mode

Two separate things, easily confused:

- **Session permission mode.** Add `"auto"` and `"dontAsk"` to the protocol's `PermissionMode` union
  and to the web picker. This is additive to a string-union type already carried on `session.create`
  and `session.set_permission_mode`, so no envelope changes. **`auto` becomes the recommended default
  for new sessions**, replacing `bypassPermissions` — restoring the safety floor lost in `3084128`,
  using Anthropic's classifier rather than Anvil's deleted regex table.
- **`autoMode` classifier config.** The `environment`, `allow`, `soft_deny`, `hard_deny`, and
  `classifyAllShell` keys in `~/.claude/settings.json`. Read the effective config via
  `claude auto-mode config`; edit via the settings file; offer `claude auto-mode critique` as an
  inline "check my rules" action and `reset` as a revert.

**Human checkpoints are the Anvil-shaped part.** Auto mode *denies* rather than escalating, but
`permissions.ask` rules are evaluated **before** the classifier and always prompt — and those prompts
are engine-originated, so they route through `mcp__anvild__approve` to the existing
`permission.request` card on every device. A user who wants a phone tap before every push adds
`Bash(git push *)` to `permissions.ask`; everything else runs unattended. That combination is a
strictly better "auto mode" than the pre-`3084128` behavior, and it needs no new plumbing.

The `$defaults` splice semantics are load-bearing and a footgun: setting any of the four arrays
*without* the literal `"$defaults"` string silently discards CC's entire built-in list for that
section. **The editor must insert `"$defaults"` by default and warn loudly when it is absent.**

### 6.6 When changes take effect

Anvil spawns a fresh `claude` per turn, so plugin/MCP/settings changes land on the **next turn** with
no restart plumbing. That turn's `init` republishes `slash_commands`, so newly installed commands
appear in the composer's `/` menu automatically via the existing `onSessionCommands` path.

Memory edits are different: CC loads `MEMORY.md` at session start, so an edit mid-session is not seen
until the next turn either. The UI says "applies to the next turn" uniformly rather than implying live
reload.

## 7. Protocol & API surface

Additive only. Capability `"cc-config"` in `src/server/identity.ts`; clients gate the whole UI on it.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cc/v1/plugins` | installed plugins |
| GET | `/api/cc/v1/plugins/available` | marketplace catalogue |
| POST | `/api/cc/v1/plugins/:op` | install / uninstall / enable / disable / update |
| GET/POST | `/api/cc/v1/marketplaces` | list / add / remove / update |
| GET/POST | `/api/cc/v1/mcp` | list (§6.3) / add / remove |
| GET | `/api/cc/v1/automode` | effective config + defaults |
| PUT | `/api/cc/v1/automode` | write the `autoMode` block |
| POST | `/api/cc/v1/automode/critique` | `claude auto-mode critique` |
| GET | `/api/cc/v1/memory` | list files + sizes + `MEMORY.md` budget state |
| GET | `/api/cc/v1/memory/:file` | file contents |
| PUT/DELETE | `/api/cc/v1/memory/:file` | write / delete |
| GET/PUT | `/api/cc/v1/memory/settings` | `autoMemoryEnabled`, `autoMemoryDirectory` |

Long operations (install, update) return a job id immediately and stream progress over the existing WS
channel.

**Path safety:** `:file` is resolved against the memory dir and rejected unless the resolved absolute
path is inside it — the same worktree-escape check `pipeline-guard.ts` already implements. No
traversal, no symlink escape.

## 8. Sync

Sync covers **plugins, MCP, and autoMode config** — the three declarative domains. Flow unchanged from
the superseded design:

1. User picks source and target server.
2. Daemon asks each for its installed set.
3. Hub computes a diff: `to-install`, `to-remove`, `version-differs`.
4. UI renders a checkbox per item. **Nothing is pre-selected for removal.**
5. The target daemon executes only ticked operations, reporting per-item results.

Per-box uniqueness is preserved by construction: a member keeps whatever was not ticked.

**Memory sync is deferred to a later phase** (interview decision). Memory is accumulated content, not
declarative config — both machines append independently, so a per-file diff is last-write-wins and
silently loses one side. The UI ships first; whether divergence actually hurts is then answerable with
evidence rather than speculation. If it does, memory joins the same engine under the same
nothing-implicit rule; if it does not, the merge machinery is never built. Recorded as **Phase B** in
§12 so it is a scheduled decision, not a forgotten one.

**Secrets:** MCP entries sync *including* secret material, under the same trust model as the account
roster (Tailscale-only boundary, `0600` on disk, hub-orchestrated). A deliberate decision carried
forward, not an oversight: it widens the blast radius of a compromised member to every synced
credential. Revisit if the fleet ever spans a machine the user does not fully control.

## 9. Security

Beyond the closed-command-set rule (§6.2) and path confinement (§7), two hazards are specific to this
design:

**The classifier reads CLAUDE.md.** Auto mode's classifier consumes the same CLAUDE.md content Claude
does, so an instruction there steers the safety gate as well as the agent. CC's own allow list draws
the line precisely — editing CLAUDE.md is auto-allowed only *"where the written content does not
change permissions, authorizations, or auto-mode behaviour in any way"* — and names Instruction
Poisoning as a block rule.

Two consequences: any future memory/CLAUDE.md sync moves classifier-steering content between machines
and must be treated as a privileged operation, not a file copy. And the already-merged
`claude-md-reflection.ts` writes to CLAUDE.md from an agent turn — in scope for that rule, and worth a
note in `SECURITY.md`.

**`autoMode` is deliberately not read from project settings.** CC excludes `.claude/settings.json` and
`.claude/settings.local.json` from `autoMode` resolution so a checked-in repo cannot inject its own
allow rules. Anvil must write `autoMode` **only** to `~/.claude/settings.json` and never to a project
settings file, or it would reopen the hole CC closed.

## 10. Error handling

- **CLI absent or failing:** every adapter surfaces the CLI's own stderr tail verbatim; Anvil never
  invents a diagnosis. Plan 9's `ensureCcAvailable()` bootstrap already covers a CC-less machine.
- **Unparseable `mcp list`:** degrade to raw text with a visible "couldn't parse" marker (§6.3). Never
  throw, never silently show an empty list — an empty list reads as "no servers", which is a lie.
- **Concurrent writes:** a per-server serialisation guard; two installs on one box queue rather than
  race. Re-entrancy guard tested, mirroring the autopilot fix in `aa36af4`.
- **Partial sync:** per-item results, with failures reported individually. A partial failure must
  report honestly as partial, not as success — the failure mode fixed in `26ce628`.
- **Memory write conflicts:** if the file changed on disk since it was read, reject the write and
  re-present. Claude writes memory during sessions; a UI edit must not clobber a concurrent agent write.
- **`MEMORY.md` over budget:** warn before saving. CC accepts the write but drops the overflow on next
  load, so a silent save is data loss in effect.

## 11. Testing

- **Unit:** parsers (`plugin list --json`, tolerant `mcp list`, `auto-mode config`) against captured
  fixtures; `$defaults` splice handling; memory path confinement; `MEMORY.md` budget calculation.
- **Contract:** the `cc-config` capability and any new wire types pinned in `test/contract/`.
- **Integration:** a fake-`claude` harness extending `test/helpers/fake-cc.ts`, so install/uninstall and
  auto-mode reads run without touching a real `~/.claude`.
- **Guard:** `CcConfigServiceDeps` guard test, per the P7 pattern.
- **Live:** one manual pass per domain on the hub, plus one sync between two boxes, recorded in §12.

**No test may mutate the developer's real `~/.claude`.** All automated tests point `HOME` at a temp
dir. This is load-bearing here in a way it was not for plugins alone: the memory tests write to a
memory directory, and the developer's real memory is irreplaceable.

## 12. Phases

| Phase | Description | Status | Tested | Pushed |
|-------|-------------|--------|--------|--------|
| 1 | CC-CLI adapters (`src/cc/plugins.ts`, `src/cc/automode.ts`) + captured fixtures | pending | no | no |
| 2 | `ccconfig-service.ts` domain service + `cc-config` capability + REST reads | pending | no | no |
| 3 | REST writes + job/progress streaming; per-server serialisation guard | pending | no | no |
| 4 | MCP read path (§6.3) + `mcp add/remove` writes | pending | no | no |
| 5 | Auto mode: `PermissionMode` gains `auto`/`dontAsk`; `auto` becomes the new-session default | pending | no | no |
| 6 | Auto mode config editor (`$defaults` guard, critique, reset) + `permissions.ask` checkpoint recipes | pending | no | no |
| 7 | Memory read path (`src/cc/memory.ts` over `init.memory_paths.auto`) + REST | pending | no | no |
| 8 | Memory writes: edit/delete, budget warning, stale-write rejection | pending | no | no |
| 9 | Memory settings: `autoMemoryEnabled` toggle, `autoMemoryDirectory` surfaced read-write | pending | no | no |
| 10 | Web: Settings → Claude Code, four sections, all actions | pending | no | no |
| 11 | Sync: diff + per-item selection + target-side apply (plugins, MCP, autoMode) | pending | no | no |
| 12 | Docs (`ARCHITECTURE.md`, `SECURITY.md` §9 notes), live pass on hub + one member | pending | no | no |
| **B** | **(deferred)** memory sync — revisit once divergence is shown to hurt | deferred | no | no |

## 13. Non-goals

- **Memory content sync between machines.** Deferred to Phase B (§8), not cancelled.
- **Relocating memory automatically.** `autoMemoryDirectory` is surfaced, never set (§6.4, principle 2).
- **Writing `.gitignore` entries, ever** (principle 2).
- **Rebuilding a danger list.** Superseded by CC's classifier (§3.1). `pipeline-guard.ts` keeps its
  [SEC-H4] role for unattended one-shots, where there is no human to ask.
- **Fixing worktree memory namespacing.** Not a bug (§3.2).
- **Phone-optimised UI.** Desktop-first; the no-TTY architecture keeps the phone possible.
- **Passthrough for remaining TUI-only commands** (`/plugin`, `/memory`, `/help`, `/status`, `/login`).
  Once this ships, `/plugin` and `/memory` have native replacements; the rest are informational.
- **A generic "run any slash command" bridge.**

## 14. Decisions log

| # | Decision | Rationale |
|---|---|---|
| D-1 | One unified "Claude Code config" surface, not two designs | The four domains share an architecture almost exactly: per-machine `~/.claude` state, non-interactive CLI subcommands, one sync engine, one capability |
| D-2 | Memory stays at CC's default location | CC already gives repo-scoped, worktree-shared, retention-exempt memory (§3.2). Relocation buys nothing and imposes a repo decision |
| D-3 | `autoMemoryDirectory` surfaced, never set by Anvil | Principle 2 — Anvil exposes knobs, the user turns them |
| D-4 | Memory sync deferred to Phase B | Accumulated content, not declarative config; per-file diff is last-write-wins. Ship the certain value, decide sync with evidence |
| D-5 | Adopt CC's `auto` mode; retire the hook/regex backstop | A Sonnet-class classifier beats a regex table, and it removes the unverified hook-`ask` spike that gated the old plan |
| D-6 | `auto` becomes the new-session default, replacing `bypassPermissions` | Restores the safety floor lost in `3084128` without Anvil owning any of the logic |
| D-7 | Human checkpoints via `permissions.ask`, not a hook | Engine-originated prompts already route to `mcp__anvild__approve` (confirmed live in cc-plan-4) |
| D-8 | MCP secrets sync with their entries | Carried forward; same trust model as the account roster. Recorded as a deliberate blast-radius decision |
| D-9 | Memory location read from `init.memory_paths.auto`, never derived | Deriving the slug would reimplement CC logic (principle 1) and break silently when CC changes it |
