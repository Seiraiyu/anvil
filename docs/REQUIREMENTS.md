# Anvil — load-bearing requirements

The non-obvious, cross-cutting constraints an agent working this repo **must not break**. Each is
enforced somewhere in code and/or tests; the citation is where to look. When a change appears to conflict
with one of these, stop and reconsider — these are deliberate, and several were paid for in incidents.

Consolidated 2026-08-01 (improvement-program v2). Companion to [`CLAUDE.md`](../CLAUDE.md),
[`ARCHITECTURE.md`](ARCHITECTURE.md), [`SECURITY.md`](../SECURITY.md), [`CI-CD.md`](CI-CD.md).

---

## 1. §3 — billing follows Claude Code (was: subscription-only, enforced at boot)

**Superseded by the CLI transport (cc plan 4, design §4.3).** The daemon used to refuse to start when
`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` were set. `src/auth/guard.ts` and `src/auth/degrade.ts`
are **deleted**: Anvil spawns the real `claude`, and a daemon that refuses to boot over an env var the
CLI is entitled to interpret was Anvil overruling the tool it drives. A turn is now billed exactly as
your terminal's `claude` is billed, and the daemon reports the auth CC declares (from `system/init`)
without ever blocking on it. A missing OAuth token is still not fatal — the daemon boots **degraded**
(serves UI + pairing) and fails at turn time.

What still holds, and what to preserve:
- Turns spawn under the **allow-list env** (`src/agent/env.ts`), which forwards only the keys it was
  handed — never the daemon's ambient environment. The launcher written by `service.sh` also `unset`s
  both metered variables. Do not widen either without understanding that it re-opens the leak path.
- The GLM/OpenRouter path still uses a per-spawn CHILD env rather than the daemon env — now for
  isolation and profile correctness rather than to clear a boot guard.

## 2. Claude Code is the permission authority (was: the daemon, via `settingSources: []`)

**Inverted by the CLI transport (cc plan 4, design §4.3–§4.4).** Sessions are no longer driven with
`settingSources: []`; the spawned CLI loads the user's real config — user/project settings,
`CLAUDE.md`, skills, plugins, hooks, and their own MCP servers — exactly like terminal Claude Code.
CC's engine decides every tool call; the daemon is only the *prompt surface*, reached through
`--permission-prompt-tool` when CC would have prompted a terminal. `agent/danger-list.ts` and the
autonomy engine in `permissions.ts` are deleted; `autonomy` on the wire became `permissionMode`
(`default | acceptEdits | plan | bypassPermissions`, protocol §4.7 delta 1).
- Consequence: this repo's `CLAUDE.md` **is** loaded by daemon-driven sessions running in this repo
  now, because the CLI loads project config like any other invocation. It is no longer inert.
- The one surviving daemon-side gate is `agent/pipeline-guard.ts`, scoped to unattended pipeline runs
  and implemented as a real CC `PreToolUse` hook (design §4.6). Anvil feature hooks are injected the
  same way — a per-session `--settings` overlay that *adds* hooks and never overrides user config.

## 3. Tailscale is the security boundary (with narrow identity-gate exceptions)

The daemon has **no app-layer request auth by design** — Tailscale is the network boundary. Do NOT add
per-request auth. The exceptions, all defense-in-depth on the browser vector or supply-chain integrity:
- **WS + state-mutating REST origin gate** (`src/server/origin.ts`, `isAllowedWsOrigin`; centralized in
  `http.ts` for all mutating `/api/*`): rejects a foreign browser Origin (SEC-H3 / SEC2-2).
- **Identity gate** (`resolveCallerIdentity`, `src/server/pairing.ts`): the fleet credential routes and
  the update-apply routes reject a *proven* different tailnet user (`otherUser`); `sameUser`/`unknown`
  proceed (SEC2-3). Never trust the `Tailscale-User-Login` header off loopback.
- **Update ancestry gate** (`applyUpdateToTarget`, SEC2-1): a target must be an ancestor of the trusted
  upstream tip before checkout — a fleet-update route can't pin the checkout to an arbitrary commit.

## 4. Protocol policy — additive-or-bump, contract-golden

`docs/plans/anvil-protocol.ts` (symlinked `anvild/protocol.ts`, imported `@protocol`) is the daemon↔client
contract for four clients (daemon, web PWA, Swift, Kotlin). Current `PROTOCOL_VERSION = 4`.
- Additive changes (new optional field / new event type) are allowed. A **rename/retype/drop of an
  existing field, or removing/renaming an event type, is breaking** — bump `PROTOCOL_VERSION` and update
  all clients in the same change.
- Guards: `test/contract/protocol-surface.test.ts` (version + type-literal set),
  `test/contract/wire-shape.test.ts` (required fields + types of the critical v4/hello/permission
  envelopes). If either fails, do NOT edit the golden to match — reconcile the clients.

## 5. Update / rollback guarantees

The self-update + fleet rollout must **survive a bricked release**.
- **Frozen Update API v1** (`UPDATE_API_VERSION`, `src/daemon/update-api.ts`): response shapes are
  additive-only (guarded by `update-api-contract.test.ts`); bump to `/v2` rather than break v1.
- **prePullSha** is recorded before the checkout moves, so a bad boot can roll back.
- **180s health gate** + out-of-process **watchdog** (`src/daemon/updater/*`): arms across
  `pulling|building|restarting`, rolls back to `prePullSha` on a crash, and re-probes after rollback so a
  target that goes healthy late is adopted (not reset backwards).
- **Hub updates itself LAST** (D6); offline members reconcile to the pinned target on reconnect (D18/D19).
- Concurrency: a single in-flight lock serializes all apply transports (BE2-28). Rollback is a **health**
  guarantee, not an **authenticity** one — authenticity is the SEC2-1 ancestry gate.

## 6. Platform / ship matrix

Every merge to `main` cuts a full release (`.github/workflows/release.yml`): Android → Firebase, iOS →
TestFlight, both macOS surfaces → Sparkle appcasts, web bundled into each. No git tags for the app stores
(dormant by design). The daemon self-updates via `git pull` + restart; **native clients bundle their own
copy of the web UI**, so a daemon update never updates a phone — the app must be re-shipped. The human
version line is MAJOR.MINOR from the repo-root `VERSION` file (CI2-9), suffixed with the build SHA.
- Authoritative: [`CI-CD.md`](CI-CD.md). The merge gate (`ci.yml`) must stay a required check.

## 7. Multi-account blast radius

Claude accounts live in a **roster** (`src/auth/accounts.ts`), not just the env var. A session binds to an
account; a removed account falls back to the default. Roster + Todoist + prompt-library + environments all
replicate hub→member (daemon store + protocol event + hub-authoritative broadcast + capability gate), with
`~/.config/anvil/env` as the launcher-sourced mirror for the default account's token.
- Torn writes to `fleet.json` / the env file would cause fleet amnesia / a degraded boot, so both use
  `writeFileAtomic` (BE2-14). A push registry / roster change fans out to the fleet — mind the amplification.
