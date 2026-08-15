# CC CLI Transport — Implementation Plan Index

Design: [`2026-08-13-cc-cli-transport-design.md`](2026-08-13-cc-cli-transport-design.md) (approved 2026-08-13). One plan doc per design phase; execute strictly in order — each plan's **GATES** header names the artifacts it consumes from earlier plans. Plans 1–2 are complete-code executable today; Plans 3–9 were planned 2026-08-13 with explicit resolve-at-execution gates (golden recordings and two spikes), per the scoping decision "all phases planned now, plan-per-slice fidelity."

| # | Plan | Fidelity | Status |
|---|------|----------|--------|
| 1 | [Baseline, SDK inventory, vendored types + golden recordings](2026-08-13-cc-cli-transport-plan-1-baseline.md) | complete code | done |
| 2 | [Managed CC installs, smoke-gated update + rollback](2026-08-13-cc-cli-transport-plan-2-cc-installs.md) | complete code (1 spike gate) | done |
| 3 | [Turn runner + retargeted mapper](2026-08-13-cc-cli-transport-plan-3-turn-runner.md) | gated on Plan 1 recordings | done |
| 4 | [Permission MCP server, questions, permissionMode delta](2026-08-13-cc-cli-transport-plan-4-permissions.md) | gated on Plan 3 + spike | done |
| 5 | [Tool servers, settings-overlay hooks, skills](2026-08-13-cc-cli-transport-plan-5-tools-hooks.md) | gated on Plans 3–4 | done |
| 6 | [Transcript reconciler + PTY attach](2026-08-13-cc-cli-transport-plan-6-reconciler.md) | gated on Plan 3 + transcript fixture | done |
| 7 | [One-shot conversion + SDK deletion](2026-08-13-cc-cli-transport-plan-7-oneshot.md) | gated on Plans 3–5 | done |
| 8 | [Full-parity sweep + flag flip](2026-08-13-cc-cli-transport-plan-8-parity.md) | gated on Plans 3–7 | done |
| 9 | [Platform hardening, docs, release](2026-08-13-cc-cli-transport-plan-9-platforms.md) | gated on Plan 8 | done |

**All nine plans shipped to `origin/main` on 2026-08-15** via the fork's own PRs #1 (plans 1–8) and #2 (plan 9).
The status column above was left at `pending` until 2026-08-15 even as each plan's own task table went to `done` —
the exact drift the rules of the road below forbid. Corrected here.

Supporting docs: [`2026-08-13-cc-transport-sdk-inventory.md`](2026-08-13-cc-transport-sdk-inventory.md) (created by Plan 1 Task 2).

Follow-ups: [`2026-08-15-claude-code-config-management-design.md`](2026-08-15-claude-code-config-management-design.md) — one Anvil surface for the whole per-machine `~/.claude` config (plugins, MCP, auto-mode config, memory), with fleet sync. It also closes the floor that Plan 4 Task 7 removed with the autonomy engine, by adopting Claude Code's native `auto` permission mode (shipped 2026-08-14) rather than rebuilding a danger list. The hand-rolled backstop that was briefly designed for this is deleted, unexecuted; its problem statement lives on in that design's §3.1.

**Rules of the road** (bind every plan):
- A gated plan is re-validated against its inputs before execution; if a gate finding contradicts the plan, the plan doc is amended first (committed), then executed — plans never drift silently from reality.
- Status tables in each plan doc are updated as tasks land (statuses: pending / in\_progress / done; Tested and Pushed flipped only on real evidence).
- The four CI gates (`typecheck`, `typecheck:web`, `build:web`, `bun test`) stay green at every commit.
- Protocol edits happen in `docs/plans/anvil-protocol.ts` (the real file; `anvild/protocol.ts` is a symlink), with wire-type golden regen via `bun test/contract/regen-golden.ts`.
