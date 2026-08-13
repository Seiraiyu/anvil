# CC CLI Transport — Plan 9: Platform hardening, docs, release

**Goal:** Fresh installs on Linux (systemd/WSL2) and macOS (LaunchAgent) reach a working CLI-direct session; docs tell the new story; first fork release cut.
**Architecture:** Design §5 phase 9, §6 platforms constraint.

**GATES:** Plan 8 merged.

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | `scripts/service.sh` path: verify install flow bootstraps a managed CC when none exists (both platforms) | pending | no | no |
| 2 | Linux/WSL2 pass: fresh install → session → phone dialog → CC update → rollback, on this machine | pending | no | no |
| 3 | macOS pass: same script on a Mac; LaunchAgent + `tailscale serve` unchanged from upstream | pending | no | no |
| 4 | Docs: rewrite `docs/ARCHITECTURE.md` "one big idea" section (SDK → CLI-direct), README auth section (defer-to-CC), new CC-updater section; note the CLI-version display for terminal-vs-daemon skew (design §4.8 nuance) | pending | no | no |
| 5 | Release: version bump per `RELEASING.md`, release notes via `scripts/gen-release-notes.ts`, tag | pending | no | no |
| 6 | Housekeeping: upstream license issue outcome recorded; upstream merge dry-run (`git merge upstream/main --no-commit`) to size the drift | pending | no | no |

Notes:
- CI (Bun 1.3.14 pinned, `.github/workflows/ci.yml`) already runs on Linux; the mac pass is manual against real hardware — record results in the phase table, don't fake a runner.
- WSL2 specifics to verify on Task 2: Tailscale reachability from phone → WSL2 daemon (mirrored networking or port-proxy), and that `~/.claude` used by the daemon is the same one the user's terminal CC uses.

**Phase acceptance (design §5.9):** fresh install on Linux and macOS via `service.sh` reaches a working session on both.
