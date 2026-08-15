# CC CLI Transport — Plan 9 platform verification runbook (Tasks 2 & 3)

Two on-hardware passes that cannot be run headlessly from a build agent: a Linux/WSL2 pass and a
macOS pass. Both check the same thing — **design §5.9: a fresh `service.sh install` reaches a
working CLI-direct session** — with the platform-specific bits that only differ inside
`service.sh`'s `svc_*` abstraction (launchd vs systemd --user) and in how Tailscale reaches the box.

**How to use this.** Run the steps in order, paste the real output into the *Result* column, and
transcribe the filled tables back into
[`2026-08-13-cc-cli-transport-plan-9-platforms.md`](2026-08-13-cc-cli-transport-plan-9-platforms.md).
A step you skip is recorded as **skipped**, not as pass — the plan's rule of the road is that
`Tested` flips only on real evidence.

> **This destroys and rebuilds a working install.** `uninstall` keeps `$STATE_DIR`, but the
> fresh-machine simulation below deliberately moves `~/.anvil` and `~/.config/anvil/env` aside. Do
> it on a machine whose sessions you can afford to interrupt, and note the restore step (R1) — it
> is the difference between "a fresh-install test" and "I lost my sessions".

## Reference: what the installer touches

| Thing | Path / name | Platform |
|---|---|---|
| Service label | `com.anvil.anvild` | both |
| Watchdog label | `com.anvil.anvil-updater` | both |
| Unit file | `~/Library/LaunchAgents/com.anvil.anvild.plist` | macOS |
| Unit file | `~/.config/systemd/user/com.anvil.anvild.service` | Linux |
| Launcher | `~/.local/bin/anvild-launch` | both |
| Logs | `~/.local/state/anvil/anvild{,.error}.log` | both |
| Token / env | `~/.config/anvil/env` (0600) | both |
| Daemon state | `~/.anvil` (`ANVIL_STATE_DIR`) | both |
| Managed CC | `~/.anvil/cc/versions/<v>`, `current`/`previous` symlinks | both |
| Port | `7701` (`ANVIL_PORT`) | both |

Subcommands: `install` · `restart` · `status` · `logs` · `uninstall` · `install-updater`.

---

## Task 2 — Linux / WSL2 pass

### Preconditions

| # | Check | Command | Expect |
|---|---|---|---|
| P1 | systemd --user is usable | `systemctl --user show-environment >/dev/null && echo ok` | `ok` (else `loginctl enable-linger $USER`, re-login) |
| P2 | Bun ≥ 1.3.14 | `bun --version` | `1.3.14`+ |
| P3 | Tailscale up | `tailscale status \| head -3` | this node listed |
| P4 | A phone on the same tailnet, Anvil installed or the PWA reachable | — | — |

### Fresh-machine simulation

| # | Step | Command | Result |
|---|---|---|---|
| F1 | Note what you're about to move | `ls ~/.anvil ~/.config/anvil/env` | (record) |
| F2 | Tear down the service | `anvild/scripts/service.sh uninstall` | `removed com.anvil.anvild + com.anvil.anvil-updater` |
| F3 | Move state aside (do **not** delete) | `mv ~/.anvil ~/.anvil.bak-$(date +%s)` | — |
| F4 | Move the token aside | `mv ~/.config/anvil/env ~/.config/anvil/env.bak` | — |
| F5 | Hide any PATH `claude` for the bootstrap test | `mv "$(command -v claude)" "$(command -v claude).hidden"` | record the path you moved |
| F6 | Confirm the machine looks fresh | `command -v claude; ls ~/.anvil 2>&1` | no claude; no such directory |

### The pass

| # | Step | Command / action | Expect | Result |
|---|---|---|---|---|
| 1 | Install | `anvild/scripts/service.sh install` | ends `healthy: {...}` + a `URL:` line; **non-zero exit is a fail** | |
| 2 | Degraded boot is honest | open the printed URL | setup screen (no token) rather than a crash | |
| 3 | Unit is real | `systemctl --user is-enabled com.anvil.anvild; systemctl --user is-active com.anvil.anvild` | `enabled`, `active` | |
| 4 | Watchdog armed | `systemctl --user is-active com.anvil.anvil-updater` | `active` (a warning at install → record and continue) | |
| 5 | Restore the token | `mv ~/.config/anvil/env.bak ~/.config/anvil/env && anvild/scripts/service.sh restart` | `healthy` | |
| 6 | **CC bootstrap** (task 1's whole point) | create a session, send `say PONG`; watch `anvild/scripts/service.sh logs` | log shows `[cc] no Claude Code found … bootstrapping the latest…` then `[cc] bootstrapped Claude Code <v>`; the turn answers | |
| 7 | Bootstrap landed in the store | `ls -l ~/.anvil/cc/current; ~/.anvil/cc/current/bin/claude --version` | symlink → `versions/<v>`; version prints | |
| 8 | Card agrees | Settings → this server → Claude Code row | shows the same version (not "not installed") | |
| 9 | Survives restart | `systemctl --user restart com.anvil.anvild`, send another turn | answers without re-downloading | |
| 10 | **Phone permission dialog** | from the phone, run a turn that needs approval (e.g. ask it to `rm` a scratch file with `permissionMode: default`) | dialog appears **on the phone**; answering there unblocks the turn on the laptop | |
| 11 | Prompt waits, doesn't time out | leave step 10's dialog ~2 min before answering | still answerable; turn resumes | |
| 12 | **CC update** | Settings → Claude Code → Check, then Update | phases `checking → downloading → smoking → flipping → healthy`; toast names the new version | |
| 13 | In-flight turn unaffected | start a long turn, press Update mid-turn | the running turn completes on the old binary | |
| 14 | **Rollback** | Settings → Claude Code → Rollback | `rolled-back`; `~/.anvil/cc/current` points at the previous version; a turn still answers | |
| 15 | WSL2: phone → daemon reachability | from the phone, load the printed URL | UI loads (if not: WSL2 mirrored networking or a port-proxy is required — record which) | |
| 16 | WSL2: same `~/.claude` as your terminal | `claude config ls` in a terminal vs a daemon session reading `~/.claude/settings.json` | same file, same settings | |
| 17 | Skills/CLAUDE.md really load | in a session, ask "what does this repo's CLAUDE.md tell you?" | it can answer — proves `settingSources` is no longer suppressed | |

### Restore

| # | Step | Command |
|---|---|---|
| R1 | Put your real state back | `anvild/scripts/service.sh uninstall && rm -rf ~/.anvil && mv ~/.anvil.bak-* ~/.anvil` |
| R2 | Un-hide the PATH claude | `mv <path>.hidden <path>` |
| R3 | Reinstall | `anvild/scripts/service.sh install` |

---

## Task 3 — macOS pass

Same script, launchd instead of systemd. Run on a Mac (this tailnet has `davids-mac-mini` and
`davids-mac-mini-2`). Steps 6–14 above are platform-independent — run them too; the table below
covers only what genuinely differs.

| # | Step | Command / action | Expect | Result |
|---|---|---|---|---|
| M1 | Bun bootstrap from a plain shell | on a Mac with no Bun: `anvild/scripts/service.sh install` | the installer fetches Bun v1.3.14 itself and continues | |
| M2 | Install | `anvild/scripts/service.sh install` | `healthy:` + `URL:` | |
| M3 | LaunchAgent loaded | `launchctl print gui/$(id -u)/com.anvil.anvild \| head -20` | present, `state = running` | |
| M4 | Starts at login | reboot (or `launchctl bootout` + login) | daemon comes back by itself | |
| M5 | Watchdog | `launchctl print gui/$(id -u)/com.anvil.anvil-updater \| head` | present | |
| M6 | `tailscale serve` unchanged from upstream | `tailscale serve status` | port 7701 fronted; URL line is `https://<magicdns>` | |
| M7 | Serve-denied fallback still works | if the operator check denies serve, re-read the install output | it prints the grant instructions and falls back to plain HTTP on the tailnet IP | |
| M8 | Logs land in the same place | `tail -5 ~/.local/state/anvil/anvild.log` | populated (plist `Std*Path` matches Linux) | |
| M9 | Then run Linux steps 6–14 | — | identical results | |
| M10 | Apple client | open the macOS/iOS app against this daemon | session list + a turn work | |

> **Note for M10:** the native shells bundle their own copy of the web UI
> (`anvild/web/bundle-native.ts`), so a daemon-side web change is **not** visible in an installed
> app until the app is re-shipped. If the app looks stale, that is expected, not a failure.

---

## Recording the result

For each of Tasks 2 and 3, transcribe into the plan doc:
- the platform + OS version + Bun version + the CC version bootstrapped,
- one line per numbered step: pass / fail / skipped, with the real output for anything that failed,
- and flip `Status` / `Tested` **only** if every non-skipped step passed.

If a step fails, that is a finding, not a blocked runbook: file it as its own commit with a test,
per the plan-8 rule that a gap gets a commit + a test.
