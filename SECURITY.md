# Security

## Trust model

Anvil's security boundary is **Tailscale + its ACLs**. The `anvild` daemon exposes its HTTP/WebSocket
API on a tailnet address and is **unauthenticated by design** — every device and user that can reach
the daemon over the tailnet is trusted at the network layer. This is a deliberate architectural
decision, not a gap.

**The one hard requirement:** the daemon must **never** be exposed off-tailnet. Do not bind it to a
public interface, port-forward it, or place it behind a reverse proxy that terminates outside the
tailnet. Restrict access with Tailscale ACLs so only the intended devices/users can reach it. If you
need to narrow access further, use tailnet ACLs — not an app-layer password.

Because there is (deliberately) no app-layer password, anyone who can route to `host:7701` can drive
most of the API. That is acceptable **only** under the tailnet boundary above. Two **narrow exceptions**
exist as defense-in-depth — they are NOT app-layer auth, they gate specific abuse vectors the network
boundary can't:
- **Identity gate** on the fleet-credential + update-apply routes: a caller `whois` proves is a
  *different* tailnet user is rejected even on-tailnet (`resolveCallerIdentity`, `src/server/pairing.ts`);
  a `sameUser`/`unknown` caller proceeds. The `Tailscale-User-Login` header is trusted only from loopback.
- **Origin gate** on `/ws` **and every state-mutating `/api/*` route**: a foreign browser Origin is
  rejected, closing the cross-site-from-a-trusted-browser vector (below).

## What the daemon still defends against (independent of the network boundary)

Even with a trusted tailnet, these controls exist because they protect against threats the network
perimeter can't:

- **Autonomous agent code-execution.** The unattended dev pipeline runs a third-party model (GLM)
  with Write/Edit/Bash. Every tool call is gated through a danger list that **hard-denies**
  destructive commands, writes escaping the session worktree, and credential/secret paths
  (`src/agent/pipeline-guard.ts` — a real Claude Code `PreToolUse` hook, injected through the run's
  `--settings` overlay). Scope note: this guard covers **unattended pipeline runs only**. Interactive
  sessions are governed by Claude Code's own permission engine reading your real `~/.claude` settings
  — the daemon-side danger list and autonomy engine that used to sit on top of them were removed with
  the CLI transport, deliberately (one policy, not two: see `ARCHITECTURE.md` → *Permissions*).
  **If you rely on a tool being blocked in an interactive session, express that in your Claude Code
  settings — Anvil no longer holds a second, independent veto.**
- **`git clone` argument injection.** Clone URLs are allowlisted to `https://` / `ssh://` / scp-form
  and the `ext::` remote-helper transport is disabled, so a crafted URL can't run a shell command
  (`src/git/ops.ts` `assertSafeCloneUrl`).
- **Cross-site WebSocket / REST hijack.** The `/ws` upgrade **and every state-mutating `/api/*` route**
  check the browser `Origin` and reject foreign origins, so a malicious website loaded in a *trusted
  device's* browser can't drive the daemon (`src/server/origin.ts`; the REST gate also requires
  `application/json` on `/api/update/v1/apply` to defeat the CORS simple-request bypass). Native clients
  and the same-origin PWA are allowlisted; set `ANVIL_ALLOWED_ORIGINS` (comma-separated) to permit
  additional first-party origins.
- **Update integrity.** Self-update / fleet-rollout is unattended, so the daemon anchors trust in git:
  a target SHA must be an **ancestor of the trusted upstream tip** before checkout
  (`applyUpdateToTarget`), so a fleet-update route can only move the checkout to a commit reachable from
  the release track — never an arbitrary attacker commit. The out-of-process watchdog's rollback is a
  **health** guarantee (a bad build is reverted), NOT an **authenticity** one — authenticity is the
  ancestry gate. See [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) §5.
- **Path containment.** Attachment and worktree file access is confined to the session directory;
  client-supplied filenames/ids can't traverse out (`src/attach/store.ts`, `src/fs/session-fs.ts`).
- **Local file permissions.** Files holding secrets (env file, push registries, VAPID key) are
  written `0600`.
- **Content XSS.** Rendered markdown is sanitized server-side with DOMPurify after
  shiki/KaTeX/mermaid, with `markdown-it html:false` and KaTeX `trust:false`.

## Secrets

- The Anthropic subscription token, OpenRouter key, and Todoist token live in `~/.config/anvil/env`
  (and per-store files) at `0600`; they are never logged or returned to clients (only masked
  previews are surfaced).
- **Metered keys are no longer a boot-time refusal.** The daemon used to abort startup when
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` were present; that guard was removed with the CLI
  transport (config authority belongs to Claude Code, which is entitled to interpret those variables).
  What remains: turns are spawned under an **allow-list env** (`src/agent/env.ts`) that forwards only
  the keys it was explicitly given, and the launcher `service.sh` writes `unset`s both variables — so
  a key in your login shell still does not reach an agent subprocess. The residual risk is a key placed
  deliberately in `~/.config/anvil/env` or in the account roster: Anvil will now honour it, and meter
  you. Treat "is my Claude Code billing metered?" as a question about your CC auth, not about Anvil.
- **Multiple Claude accounts.** A hub can hold several labelled subscription tokens in
  `<stateDir>/accounts.json` (`0600`, written atomically). Understand the blast radius before adding
  a second account:
  - **Every member of a fleet holds every token.** The roster is replicated in full on the existing
    credential push, so adding an account to the hub copies that token to every paired machine. A
    machine you would not trust with a subscription should not be in the fleet.
  - The push rides the same gate as the single-token rotation — same-user tailnet identity **and** a
    matching `hubServerId` — and is only sent to peers advertising the `accounts` capability.
  - **No raw token ever reaches a client.** Every read path (`auth.accounts`, `GET
    /api/fleet/accounts`) returns `{ id, label, masked, createdAt }` only.
  - Tokens are validated on the way in at every entry point — UI, replication and the boot migration
    — so a metered `sk-ant-api…` key cannot enter the roster and reach a member.

## Managing `~/.claude` from the app

Anvil can edit the per-machine Claude Code config — plugins, MCP servers, the auto-mode classifier
config, and memory (`/api/cc/v1/*`, behind the `cc-config` capability). Two hazards are specific to
that surface and worth stating plainly.

- **The auto-mode classifier reads `CLAUDE.md`.** An instruction written there steers the safety gate
  as well as the agent. Claude Code auto-allows `CLAUDE.md` edits only *where the content does not
  change permissions, authorizations, or auto-mode behaviour* — but note that Anvil's merged
  `claude-md-reflection` path writes `CLAUDE.md` from an agent turn, and is in scope for that rule.
  Any future memory/`CLAUDE.md` sync would move classifier-steering content between machines, so it
  must be treated as privileged replication, not a file copy. (This is part of why memory is
  deliberately excluded from the sync diff today.)
- **`autoMode` is only ever written to `~/.claude/settings.json`.** Claude Code deliberately excludes
  *project* settings from `autoMode` resolution, so that a checked-in repository cannot inject its
  own allow rules into the classifier. Writing the block to a project settings file would reopen
  exactly the hole CC closed; the writer is pinned to the user file by test.

Beyond those: plugin ids and MCP server names are **rejected** rather than escaped when they carry
shell metacharacters, MCP configs travel to the CLI as a single JSON argument rather than shell
words, memory file access is confined to CC's reported memory directory (traversal and symlink
escapes refused), and every write route requires a JSON content-type and rejects a proven different
tailnet user — the same gate as a binary update, because installing a plugin is code execution on
that box. MCP rows render name, target and status only; header, env and token values are never sent
to a client.

## Reporting a vulnerability

Email **evan.ruff@oxos.com** with details and reproduction steps. Please do not open a public issue
for security-sensitive reports. Since Anvil is tailnet-scoped, include whether the issue is reachable
*within* the trust model (agent execution, browser origin, path traversal, content) versus assuming
off-tailnet exposure (out of scope by design).
