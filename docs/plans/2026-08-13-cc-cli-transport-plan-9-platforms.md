# CC CLI Transport — Plan 9: Platform hardening, docs, release

**Goal:** Fresh installs on Linux (systemd/WSL2) and macOS (LaunchAgent) reach a working CLI-direct session; docs tell the new story; first fork release cut.
**Architecture:** Design §5 phase 9, §6 platforms constraint.

**GATES:** Plan 8 merged.

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | `scripts/service.sh` path: verify install flow bootstraps a managed CC when none exists (both platforms) | done (gap found + closed) | yes | no |
| 2 | Linux/WSL2 pass: fresh install → session → phone dialog → CC update → rollback, on this machine | blocked on operator (runbook ready) | no | no |
| 3 | macOS pass: same script on a Mac; LaunchAgent + `tailscale serve` unchanged from upstream | blocked on operator (runbook ready) | no | no |
| 4 | Docs: rewrite `docs/ARCHITECTURE.md` "one big idea" section (SDK → CLI-direct), README auth section (defer-to-CC), new CC-updater section; note the CLI-version display for terminal-vs-daemon skew (design §4.8 nuance) | done | yes | no |
| 5 | Release: version bump per `RELEASING.md`, release notes via `scripts/gen-release-notes.ts`, ~~tag~~ (this repo has no tag step) | prepped, not cut — 4 blockers | n/a | no |
| 6 | Housekeeping: upstream license issue outcome recorded; upstream merge dry-run (`git merge upstream/main --no-commit`) to size the drift | done (license needs an owner decision) | yes | no |

Notes:
- CI (Bun 1.3.14 pinned, `.github/workflows/ci.yml`) already runs on Linux; the mac pass is manual against real hardware — record results in the phase table, don't fake a runner.
- WSL2 specifics to verify on Task 2: Tailscale reachability from phone → WSL2 daemon (mirrored networking or port-proxy), and that `~/.claude` used by the daemon is the same one the user's terminal CC uses.
- Tasks 2 and 3 are executed from [`2026-08-13-cc-cli-transport-plan-9-platform-runbook.md`](2026-08-13-cc-cli-transport-plan-9-platform-runbook.md) — step-by-step, with a Result column to fill in and a restore procedure, since the fresh-machine simulation tears down a working install.

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

**Task 6 — housekeeping.**

*Upstream license (design open question 4): asked-for outcome never happened.* `gte619n/anvil`
reports `license: null` — still no license file, still all-rights-reserved by default — and no
license request exists in its issues (searched open + closed). The interview decision was "fork
proceeds; ask upstream in parallel"; the *asking* half was never done. **This is now blocking a
clean release, not merely untidy:** this fork's `README.md` §License says "MIT", which is a claim
this fork is not in a position to make about upstream's code. Two honest resolutions, both the
owner's call, neither taken unilaterally here:
1. File the request upstream (MIT/Apache-2.0) and hold the MIT claim until it lands, or
2. Qualify the README now — state the fork's *own* additions' terms and record that the upstream
   base is unlicensed.
No issue was filed on a third party's repository without a decision.

*Upstream merge dry-run (`git merge upstream/main --no-commit --no-ff`, aborted clean).* Drift is
**much smaller than the 66-commit divergence suggests**. `upstream/main` is `e6e271c`, five commits
ahead of merge-base `e68591c` (the loops-circuit work, +5937/-61 across 47 files). The merge stops
on exactly **three** conflicts:

| File | Kind | Size |
|---|---|---|
| `anvild/src/server/identity.ts` | UU — both sides append a capability (`cc-update` vs `loops`) | trivial, keep both |
| `anvild/test/web/transcript-serialize.test.ts` | UU — comment-only, upstream annotates a `30_000` timeout we also touched | trivial |
| `anvild/src/agent/query.ts` | **DU — deleted by us, modified by them** | the real work |

Only the third is substantive, and it is the predicted shape: plan 7 deleted `runAgentQuery` with
the SDK, and upstream's loops-intake feature (#199) then *extended* it — an `onStep` callback firing
per `tool_use` plus a `toolDetail()` helper, so a run can stream its real activity. Upstream now has
four callers (`loops/intake-model.ts`, `session/loop-service.ts`, `pipeline/adapters.ts`,
`pipeline/phases.ts`); ours route through `cc/oneshot.ts`. So the port is: add an `onStep`-equivalent
to `runCcQuery` — which is strictly easier there, since stream-json already delivers every
`tool_use` block the callback wants and `oneshot.ts` is already parsing them for `ExitPlanMode`.
**Estimate: a day, dominated by the loops feature's own surface, not by the transport.** The
transport swap did not make upstream merges expensive; the one file it makes expensive is the one
file it deleted.

Recommendation: do the merge as its own change *before* the release, not folded into it — the
conflict set is small enough today that letting it age is the only way it gets hard.

**Task 5 — release: prepared, deliberately not cut.** Scoped to "prep only, stop before tag/push"
(operator decision, 2026-08-15). Two corrections to the task as written, found while doing it:

*There is no tag.* `RELEASING.md` is explicit — "**Merge to `main`.** That's it — no tag to push."
A full release fires from `.github/workflows/release.yml` on push to `main`, minting
`MAJOR.MINOR.<run_number>` and fanning out to Firebase / TestFlight / Sparkle. The plan's "tag" step
describes a ritual this repo doesn't have.

*`4.1` was not available.* Upstream took it in `edcf46f` ("bump version to 4.1") while we were on
`4.0`; picking it would have collided at the very next merge. Bumped `VERSION` → **`5.0`** instead,
which also lines up with this fork's `PROTOCOL_VERSION = 5` (upstream is still on 4) — the transport
work *is* a major-line change: `autonomy` → `permissionMode` is a breaking wire delta and the Agent
SDK is gone. Release notes generated and checked in as
[`…-plan-9-release-notes-draft.txt`](2026-08-13-cc-cli-transport-plan-9-release-notes-draft.txt):
67 changes, correctly grouped, with both breaking changes surfaced at the top.

**The fork cannot actually ship a release today.** This is the finding, not a formality — four
blockers, none of them fixable inside this task:
1. **No signing secrets.** `release.yml` consumes `IOS_DIST_P12_BASE64`, `MAC_DEVELOPER_ID_P12_BASE64`,
   `SPARKLE_ED_PRIVATE_KEY`, `FIREBASE_SERVICE_ACCOUNT`, … — `gh secret list --repo Seiraiyu/anvil`
   returns nothing. Every ship job would fail at signing. The secrets live in *upstream's* Google
   Secret Manager project (`gte619n-anvil`), and `RELEASING.md` §1's `push-secrets.sh` flow would
   have to be re-run against a fork-owned project with fork-owned Apple/Firebase credentials.
2. **The Sparkle feed points at upstream.** `apple/make-app.sh` hard-codes
   `https://gte619n.github.io/anvil/appcast.xml` (overridable via `SPARKLE_FEED_URL`). Shipping a
   fork build against upstream's appcast would offer *their* updates to *our* installs.
3. **`main` doesn't have the work.** `cc-cli-transport` is 66 commits ahead of `origin/main` and
   merged nowhere; the release model triggers on `main`. Merging the branch is the release action.
4. **The license question (Task 6) is upstream of all of this.** Publishing artifacts widens the
   exposure of a README that claims MIT over an unlicensed base.

Also noted, not changed: `apple/project.yml` `MARKETING_VERSION` is `2.1.0`, which `RELEASING.md`
says to keep in MAJOR.MINOR sync by hand. It has been adrift upstream since well before this fork
(upstream sat at `4.0`/`4.1` with the same `2.1.0`), and it only affects raw Xcode dev builds — so
correcting it here would be gratuitous divergence against design §6's "keep changes outside
`src/agent`/`src/cc` minimal and mechanical". Flagging rather than fixing.

Not done, and awaiting a decision: creating a tag, pushing anything to `origin`, opening the PR that
merges this branch to `main`, or touching the release workflow.
