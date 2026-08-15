# CC CLI Transport — Plan 9: Platform hardening, docs, release

**Goal:** Fresh installs on Linux (systemd/WSL2) and macOS (LaunchAgent) reach a working CLI-direct session; docs tell the new story; first fork release cut.
**Architecture:** Design §5 phase 9, §6 platforms constraint.

**GATES:** Plan 8 merged.

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | `scripts/service.sh` path: verify install flow bootstraps a managed CC when none exists (both platforms) | done (gap found + closed) | yes | no |
| 2 | Linux/WSL2 pass: fresh install → session → phone dialog → CC update → rollback, on this machine | pending | no | no |
| 3 | macOS pass: same script on a Mac; LaunchAgent + `tailscale serve` unchanged from upstream | pending | no | no |
| 4 | Docs: rewrite `docs/ARCHITECTURE.md` "one big idea" section (SDK → CLI-direct), README auth section (defer-to-CC), new CC-updater section; note the CLI-version display for terminal-vs-daemon skew (design §4.8 nuance) | done | yes | no |
| 5 | Release: version bump per `RELEASING.md`, release notes via `scripts/gen-release-notes.ts`, tag | pending | no | no |
| 6 | Housekeeping: upstream license issue outcome recorded; upstream merge dry-run (`git merge upstream/main --no-commit`) to size the drift | pending | no | no |

Notes:
- CI (Bun 1.3.14 pinned, `.github/workflows/ci.yml`) already runs on Linux; the mac pass is manual against real hardware — record results in the phase table, don't fake a runner.
- WSL2 specifics to verify on Task 2: Tailscale reachability from phone → WSL2 daemon (mirrored networking or port-proxy), and that `~/.claude` used by the daemon is the same one the user's terminal CC uses.

**Phase acceptance (design §5.9):** fresh install on Linux and macOS via `service.sh` reaches a working session on both.

---

## Execution notes (2026-08-15)

**Task 1 — the thing to "verify" did not exist.** `service.sh` never mentioned CC; `main.ts` only
called `bridgeCliPath()`, which no-ops on an empty store; `resolveCcCommand()` then fell back to a
bare `claude`. Plan 2's acceptance had defined bootstrap as "`apply()` on an empty store" — i.e. a
*user-initiated* tap on the settings card — so on a machine with no managed install **and** no
`claude` on `PATH`, the first turn died with a raw ENOENT out of `spawnInGroup`, and §5.9's "a fresh
install reaches a working session" was false. Closed in `src/cc/bootstrap.ts` (commit `3c36949`):
the turn paths (`turn-runner`, both `oneshot` entry points) await a spawnable CC, and a machine with
none downloads one through the **same** `CcUpdater.apply()` the card drives — same smoke gate, same
atomic flip, same pollable phase state. Precedence unchanged and now explicit: `ANVIL_CLI_PATH` →
managed `current` → `PATH`. Single-flight + latched on success; **not** latched on failure, so the
next turn retries. `CcBootstrapError` is a distinct type because `failTurn`'s `isResumeRejectedError`
matches "unauthorized"/"forbidden" and would otherwise read a CDN 403 as a dead conversation.
- Verified offline: 9 tests in `test/unit/cc-bootstrap.test.ts` (each confirmed to fail when negated).
- Verified **live** on this WSL2 machine: empty store + a PATH probe returning nothing → downloaded,
  smoked and activated cc **2.1.233** in **8.7s**; `ANVIL_CLI_PATH` adopted, updater phase `healthy`,
  `<binary> --version` → `2.1.233 (Claude Code)`.
- `service.sh` itself needs no CC step: its install path is platform-symmetric behind the `svc_*`
  abstraction, and bootstrap belongs in the daemon (the download is retryable in place, the install
  script is not). Its stale "the Claude agent SDK" comment was corrected. **The macOS half of "both
  platforms" remains Task 3's job** — this is a Linux/WSL2 live result plus a code-symmetry argument,
  not a Mac run.

**Task 4 — docs.** Rewrote ARCHITECTURE's "one big idea" (SDK → CLI-direct, with the *why*: config
authority), redrew both its diagrams, replaced the "mostly-autonomous with a danger-list backstop"
permission section (that engine is deleted) with the CC-decides / daemon-prompts flow, rewrote the
auth section, and added a **Managed Claude Code installs** section covering the smoke gate, the
atomic flip, rollback, bootstrap, and poll-don't-push. README: transport note, permissions bullet,
auth callout, and a quick-start line saying you needn't install CC yourself.

Three stale claims found outside the task's literal list, two of them **security-relevant**, all fixed:
- `SECURITY.md` still promised the interactive danger list (`src/agent/danger-list.ts`, deleted) and
  a boot refusal on metered keys (`src/auth/guard.ts`, deleted). A security doc asserting a control
  that no longer exists is worse than one that is merely out of date.
- `docs/REQUIREMENTS.md` §1 and §2 were the *inverse* of current behavior. Both rewritten as explicit
  supersessions naming what replaced them and what still holds.
- `CLAUDE.md`'s pitfall "this `CLAUDE.md` is NOT auto-loaded into daemon-driven sessions" is now
  backwards — the CLI loads project config — so it was inverted, and the auth paragraph corrected.

**CLI-version skew (the §4.8 nuance).** Documented in ARCHITECTURE. Recorded as a follow-up rather
than fixed here: `wireCcUpdate` labels the row `Claude Code: not installed` whenever `/status` has no
`current`, which after Task 1 is the *common* case for anyone who already had a `claude` — turns run
fine on the PATH copy while the card implies nothing is there. The honest fix is an additive
`/api/cc/v1/status` field reporting the effective binary + its version (`managed | path | override`),
which is a REST-contract change this task shouldn't smuggle in.
