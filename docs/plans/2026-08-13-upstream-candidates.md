# Fork-local changes that should go upstream

We are not contributing to the upstream repo (gte619n/anvil) yet. This doc tracks changes made
on this fork that are general fixes — not CC-CLI-transport work — and should be offered upstream
when contribution starts. Keep one entry per change, newest first.

## 2026-08-13 — WEB2-6 test timeout bump (`anvild/test/web/transcript-serialize.test.ts`)

The `[WEB2-6] a 1000-bubble transcript saves a bounded slice` test deterministically times out
on slower machines (WSL2: 6.3–8.8s against bun's 5s default). Building the 1000-bubble DOM is
the slow part; the perf guard is the clone-count assertion, not wall time. Fix: explicit
`30_000`ms timeout on that one test. Upstream-worthy as-is.

Related (not fixed, watch for recurrence): `test/web/ws.test.ts` flaked once under full-suite
load (passes in isolation) — timing-sensitive, may deserve the same treatment if it recurs.
