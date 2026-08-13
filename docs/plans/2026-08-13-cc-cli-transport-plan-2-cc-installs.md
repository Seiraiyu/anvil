# CC CLI Transport — Plan 2: Managed CC installs with smoke-gated update + rollback

**Goal:** The daemon owns versioned Claude Code installs under `~/.anvil/cc/` with an atomic `current` flip, smoke-gated updates, one-tap rollback, a frozen `/api/cc/v1/*` REST surface, and a settings-card UI — updatable from any device.
**Architecture:** Net-new store (`cc/install.ts`) — the daemon self-updater is git-in-place, so the transferable patterns are `CommandRunner` injection, the phase machine, single-writer state (`update-state.ts` lesson), and frozen-contract tests; the atomic-flip precedent is `web/build.ts`'s `dist.next`→rename. Design §4.8, §4.7 delta 4.
**Tech Stack:** Bun, node:fs symlinks, existing `src/server/http.ts` route table, `serverFetch` polling UI (fleet precedent).

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | `ccDir` in config (test first) | done | yes | yes |
| 2 | Installer-contract spike (LIVE probe, resolves design Assumption 4) | done | yes | yes |
| 3 | `CcInstalls` store: versions, atomic flip, rollback (test first) | done | yes | yes |
| 4 | Downloader: injectable type + official implementation per spike | done | yes | yes |
| 5 | `cc/smoke.ts` smoke gate (fake-runner tests + gated live test) | done | yes | yes |
| 6 | `cc/update.ts` orchestrator: state file, in-flight guard, check/apply/rollback | done | yes | yes |
| 7 | REST surface `/api/cc/v1/*` + `cc-update` capability + contract test | done | yes | yes |
| 8 | Web UI: CC card in server settings, poll-based apply, rollback button | done | yes | yes |
| 9 | Bridge `ANVIL_CLI_PATH` → managed `current` (SDK path benefits pre-Plan-3) | done | yes | yes |

Execution notes (2026-08-13): **Assumption 4 resolved differently than sketched** — install.sh
has no directory control (`claude install` takes only a version), but exposes the release
bucket's direct-download contract (`downloads.claude.ai/claude-code-releases/{latest,stable,
<v>/manifest.json,<v>/<platform>/claude}`, sha256 in the manifest). `officialDownloader`
downloads directly; no HOME-redirect fallback needed. Not every patch version is published
(2.1.230 → 404) — pinned targets must come from latest/stable or a previously-seen version.
Live-verified: probe (latest + pinned 2.1.229) and the smoke gate against claude 2.1.231
(`CC_SMOKE_LIVE=1`). The smoke turn runs `--setting-sources "" --strict-mcp-config` (plan-1
finding: host hooks otherwise precede init). CommandRunner gained `timeoutMs` (Bun.spawn
native timeout). REST responses carry `ccApiVersion`; contract pins live in
`test/unit/cc-api-contract.test.ts` (no OpenAPI doc — inline required-field table).

### Task 1: `ccDir` in config

**Files:** Modify `anvild/src/config.ts` · Test `anvild/test/unit/config.test.ts` (append; file exists)

**Step 1 (test):** append —
```ts
test("ccDir defaults under ~/.anvil and honors ANVIL_CC_DIR", () => {
  expect(loadConfig({}).ccDir.endsWith("/.anvil/cc")).toBe(true);
  expect(loadConfig({ ANVIL_CC_DIR: "/tmp/x" }).ccDir).toBe("/tmp/x");
});
```
**Step 2:** `bun test test/unit/config.test.ts` — Expected: FAIL (`ccDir` missing).
**Step 3 (implement):** in `Config` interface add `ccDir: string;` (after `clonesDir`); in `loadConfig` add `ccDir: expandHome(env.ANVIL_CC_DIR ?? "~/.anvil/cc"),` (mirror `clonesDir` at `config.ts:114`).
**Step 4:** test PASS + `bun run typecheck` green.
**Step 5:** `git commit -am "feat(cc): ccDir config (ANVIL_CC_DIR, default ~/.anvil/cc)"`

### Task 2: Installer-contract spike (LIVE)

**Files:** Create `anvild/test/tools/probe-cc-installer.ts`

Resolves design **Assumption 4**: can the official installer place a *pinned version* in a *caller-chosen directory*? Probe (best current knowledge — the native installer script accepts a version argument and honors a target override; verify both):

```ts
/** LIVE probe: bun test/tools/probe-cc-installer.ts <version>
 *  Tries the official installer into a temp dir; prints what worked. Findings go into
 *  Task 4's downloader implementation + design Assumption 4. */
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = process.argv[2] ?? "latest";
const dest = mkdtempSync(join(tmpdir(), "anvil-cc-probe-"));
const script = await (await fetch("https://claude.ai/install.sh")).text();
console.log("--- installer script env/flags mentioning dir/version ---");
for (const line of script.split("\n")) if (/DIR|PREFIX|TARGET|version|VERSION/i.test(line)) console.log(line);
const proc = Bun.spawn(["bash", "-c", script], {
  env: { ...process.env, HOME: dest }, // fallback isolation: redirect $HOME entirely
  stdout: "inherit", stderr: "inherit",
  ...(version !== "latest" ? {} : {}),
});
await proc.exited;
console.log("--- resulting tree ---");
console.log(readdirSync(dest, { recursive: true }));
```

**Step:** run `bun test/tools/probe-cc-installer.ts`, read the script's actual flags/env from the printed lines, then run again the supported way with a pinned version. **Record the working invocation as a comment block at the top of the probe file and commit.** GATE: Task 4's `officialDownloader` must use the *verified* invocation; if no supported pinned-version path exists, the fallback is `HOME`-redirected install + move, and `resolveLatest` comes from the installed binary's `--version`.
**Commit:** `git add anvild/test/tools/probe-cc-installer.ts && git commit -m "test(cc): installer contract probe + verified invocation notes"`

### Task 3: `CcInstalls` store

**Files:** Create `anvild/src/cc/install.ts` · Test `anvild/test/unit/cc-install.test.ts`

**Step 1 (failing tests):**
```ts
// Guards design §4.8: versioned installs, atomic current/previous flip, rollback swap.
// Uses real temp dirs + real symlinks (repo convention: never fake the filesystem).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcInstalls, binaryPath } from "../../src/cc/install";

function store(): { cc: CcInstalls; root: string } {
  const root = mkdtempSync(join(tmpdir(), "anvil-cc-install-"));
  return { cc: new CcInstalls(root), root };
}
function fakeInstall(cc: CcInstalls, v: string): void {
  const dir = cc.installDirFor(v);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(binaryPath(dir), "#!/bin/sh\necho fake\n", { mode: 0o755 });
}

test("empty store: no current, no versions", () => {
  const { cc } = store();
  expect(cc.listInstalled()).toEqual([]);
  expect(cc.currentVersion()).toBeUndefined();
});

test("activate flips current; second activate records previous", () => {
  const { cc } = store();
  fakeInstall(cc, "2.1.0"); fakeInstall(cc, "2.2.0");
  cc.activate("2.1.0");
  expect(cc.currentVersion()).toBe("2.1.0");
  cc.activate("2.2.0");
  expect(cc.currentVersion()).toBe("2.2.0");
  expect(cc.previousVersion()).toBe("2.1.0");
  expect(cc.currentBinary()).toBe(binaryPath(cc.installDirFor("2.2.0")));
});

test("activate refuses a version with no binary", () => {
  const { cc } = store();
  expect(() => cc.activate("9.9.9")).toThrow(/not installed/);
});

test("rollback swaps current and previous", () => {
  const { cc } = store();
  fakeInstall(cc, "2.1.0"); fakeInstall(cc, "2.2.0");
  cc.activate("2.1.0"); cc.activate("2.2.0");
  expect(cc.rollback()).toBe("2.1.0");
  expect(cc.currentVersion()).toBe("2.1.0");
  expect(cc.previousVersion()).toBe("2.2.0"); // swap, so rollback is reversible
});

test("rollback with no previous throws", () => {
  const { cc } = store();
  expect(() => cc.rollback()).toThrow(/no previous/);
});
```

**Step 2:** run — FAIL (module missing).
**Step 3 (implement `anvild/src/cc/install.ts`):**
```ts
/**
 * Versioned Claude Code installs (design §4.8): <root>/versions/<v>/ holds one complete
 * install; <root>/current and <root>/previous are symlinks. Flips are atomic via the
 * repo's established pattern (web/build.ts): create `<name>.next`, then rename(2) over
 * `<name>`. NET-NEW store — the daemon self-updater is git-in-place and shares no code.
 * Single-writer: only the daemon process mutates this tree (update-state.ts lesson —
 * writeFileAtomic-style atomicity does not give cross-process read-modify-write).
 */
import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";

export function binaryPath(installDir: string): string {
  return join(installDir, "bin", "claude");
}

export class CcInstalls {
  constructor(private readonly root: string) {
    mkdirSync(join(root, "versions"), { recursive: true });
  }

  installDirFor(version: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(version)) throw new Error(`bad version string: ${version}`);
    return join(this.root, "versions", version);
  }

  listInstalled(): string[] {
    return readdirSync(join(this.root, "versions")).filter((v) => existsSync(binaryPath(this.installDirFor(v)))).sort();
  }

  currentVersion(): string | undefined { return this.linkedVersion("current"); }
  previousVersion(): string | undefined { return this.linkedVersion("previous"); }

  /** Absolute path of the active binary, or undefined when nothing is activated yet. */
  currentBinary(): string | undefined {
    const v = this.currentVersion();
    return v ? binaryPath(this.installDirFor(v)) : undefined;
  }

  /** Point `current` at `version` (must have a binary); the old current becomes `previous`. */
  activate(version: string): void {
    const target = this.installDirFor(version);
    if (!existsSync(binaryPath(target))) throw new Error(`not installed: ${version}`);
    const cur = this.currentVersion();
    if (cur && cur !== version) this.flip("previous", this.installDirFor(cur));
    this.flip("current", target);
  }

  /** Swap current↔previous. Returns the version now current. */
  rollback(): string {
    const prev = this.previousVersion();
    if (!prev) throw new Error("no previous version to roll back to");
    this.activate(prev);
    return prev;
  }

  /** Delete an inactive version dir (never current/previous). */
  remove(version: string): void {
    if (version === this.currentVersion() || version === this.previousVersion()) {
      throw new Error(`refusing to remove active version: ${version}`);
    }
    rmSync(this.installDirFor(version), { recursive: true, force: true });
  }

  private linkedVersion(name: string): string | undefined {
    try { return basename(readlinkSync(join(this.root, name))); } catch { return undefined; }
  }

  private flip(name: string, target: string): void {
    const next = join(this.root, `${name}.next`);
    rmSync(next, { force: true });
    symlinkSync(target, next);
    renameSync(next, join(this.root, name)); // atomic on POSIX — in-flight turns keep their open binary
  }
}
```
**Step 4:** tests PASS; `bun run typecheck` green. **Step 5:** commit `feat(cc): versioned install store with atomic current/previous flip`.

### Task 4: Downloader

**Files:** Modify `anvild/src/cc/install.ts` (append) · Test append to `cc-install.test.ts`

Type + official implementation (**GATE: body must follow Task 2's verified invocation**; shown here in the `HOME`-redirect fallback form):
```ts
export type CommandRunner = (cmd: string[], opts: { cwd?: string; env?: Record<string, string> }) => Promise<{ code: number; out: string }>;

export const defaultRun: CommandRunner = async (cmd, opts) => { /* Bun.spawn, merge stdout+stderr, await exited — copy shape from src/daemon/selfupdate.ts's runner */ };

export type CcDownloader = (version: string, destDir: string, run?: CommandRunner) => Promise<{ version: string }>;

/** Downloads a pinned CC version into destDir via the official installer.
 *  ⚠ REPLACE the invocation below with the one Task 2's probe verified. */
export function officialDownloader(fetchText: (url: string) => Promise<string> = (u) => fetch(u).then((r) => r.text())): CcDownloader {
  return async (version, destDir, run = defaultRun) => { /* verified invocation from Task 2; must end with existsSync(binaryPath(destDir)) check and return the ACTUAL installed version from `<bin> --version` */ };
}
```
Unit tests use a fake `CommandRunner`/`fetchText` that plants a fake binary and assert: pinned version requested reaches the command line; result version read from `--version`; missing-binary result throws. Commit: `feat(cc): injectable downloader + official installer implementation`.

### Task 5: Smoke gate

**Files:** Create `anvild/src/cc/smoke.ts` · Tests `anvild/test/unit/cc-smoke.test.ts` + `anvild/test/unit/cc-smoke.live.test.ts`

```ts
/** Post-download gate (design §4.8): a candidate binary must (1) report a semver from
 *  --version and (2) complete one trivial -p turn whose stream parses to init+result.
 *  Auth-required by design: an unauthenticated machine cannot vouch for an update, so
 *  the gate fails closed with a distinguishable reason. */
export interface SmokeOutcome { ok: boolean; version?: string; reason?: string; log: string[] }
export async function smokeTest(binary: string, opts: { cwd: string; run?: CommandRunner; timeoutMs?: number }): Promise<SmokeOutcome>
```
Implementation: step 1 `--version` → regex `\d+\.\d+\.\d+`; step 2 `[binary, "-p", "Reply with exactly: ok", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--permission-mode", "bypassPermissions"]` via the runner, parse every line with `parseCCLine`, require first `system/init` + final non-error `result`; any warn ⇒ `ok:false` with the warn as reason. Timeout default 120_000 via `AbortSignal.timeout` on the runner. Unit tests: fake runner returning recorded fixture text (reuse `test/fixtures/cc/basic.ndjson`) ⇒ ok; fake returning garbage ⇒ `ok:false, reason` contains "unparseable"; fake exiting nonzero ⇒ fail with stderr tail in `log`. Live test gated exactly like `unit/openrouter.live.test.ts:9-10`: `const LIVE = process.env.CC_SMOKE_LIVE === "1";` + `test.skipIf(!LIVE)` running the real PATH `claude`. Commit: `feat(cc): smoke gate for candidate CC binaries`.

### Task 6: Update orchestrator

**Files:** Create `anvild/src/cc/update.ts` · Test `anvild/test/unit/cc-update.test.ts`

```ts
export type CcUpdatePhase = "idle" | "checking" | "downloading" | "smoking" | "flipping" | "healthy" | "rolled-back" | "error";
export interface CcUpdateState { phase: CcUpdatePhase; target?: string; from?: string; reason?: string; updatedAt: string }
export interface CcUpdaterDeps {
  installs: CcInstalls;
  download: CcDownloader;
  smoke: typeof smokeTest;
  resolveLatest: () => Promise<string>;
  stateFile: string;            // <stateDir>/cc-update-state.json — daemon is the ONLY writer
  now?: () => Date;
}
export class CcUpdater {
  constructor(deps: CcUpdaterDeps) {}
  status(): CcUpdateState & { current?: string; previous?: string; installed: string[] }
  async check(): Promise<{ current?: string; latest: string; updateAvailable: boolean }>
  async apply(target?: string): Promise<CcUpdateState>   // serialized by an in-flight promise (update-api.ts:59 precedent)
  rollback(): CcUpdateState
}
```
Behavioral contract (each line = a unit test with fake deps):
- `apply()` with no target resolves latest; already-current ⇒ immediate `healthy` no-op.
- Flow writes phases in order `checking→downloading→smoking→flipping→healthy` to the state file via `writeFileAtomic` (assert by reading the file between injected-dep pauses — copy the promise-latch idiom from `unit/driver-cleanup.test.ts:41-59`).
- Smoke failure ⇒ phase `error`, reason from smoke, **`current` symlink untouched**, downloaded dir retained for diagnosis.
- Concurrent `apply()` returns the same in-flight promise (no second download).
- `rollback()` ⇒ `installs.rollback()`, phase `rolled-back`.
- Corrupt state file on boot ⇒ swallowed, status reports `idle` (update-state.ts read-path convention).
Commit: `feat(cc): smoke-gated update orchestrator with rollback`.

### Task 7: REST surface + capability + contract test

**Files:** Modify `anvild/src/server/http.ts` (route registrations beside `/api/update/v1/*` at `:653-669`), `anvild/src/server/identity.ts` (append `"cc-update"` to the capability list at `:86-96`) · Test `anvild/test/unit/cc-api-contract.test.ts`

Routes (all identity-gated like their daemon-update neighbors; POSTs guarded by the `[SEC2-2]` `content-type: application/json` check):
- `GET /api/cc/v1/status` → `updater.status()`
- `GET /api/cc/v1/check` → `updater.check()`
- `POST /api/cc/v1/apply` body `{target?: string}` → kicks `apply`, returns current status immediately (client polls status — fleet precedent; no push, design delta 4)
- `POST /api/cc/v1/rollback` → `updater.rollback()`
Contract test mirrors `test/unit/update-api-contract.test.ts`: boot a real server via `test/helpers` `bootServer`, hit all four routes, `assertShape`-walk responses (required props present, extras allowed = additive-only). `CC_API_VERSION = 1` exported from `update.ts`; breaking ⇒ `/v2/` namespace (frozen-surface precedent `protocol.ts:63-71`).
Commit: `feat(cc): /api/cc/v1 REST surface + cc-update capability + contract test`.

### Task 8: Web UI card

**Files:** Modify `anvild/web/src/settings.ts` (extend `serverCardHtml` `:966-983` + `renderServerCards` `:984-1030`), `anvild/web/src/fleet.ts` (new `wireCcUpdate(srv)` beside `wireDaemonUpdate` `:845-918`) · Test `anvild/test/web/cc-update-card.test.ts` (template: `test/web/dialogs.test.ts`, `installDom()/uninstallDom()` in `afterAll` — mandatory)

Behavior: card row gated on `serverSupports(srv, "cc-update")` (`fleet.ts:113`); shows `current` version; **Check** → `serverFetch(srv.url, "/api/cc/v1/check")`, reveals **Update** when `updateAvailable`; **Update** → POST apply then poll `/status` every 2s (fleet-rollout idiom `fleet.ts:461-560`) rendering phase into the card's `<pre class="git-output">`; terminal phases `healthy` / `error` / `rolled-back` stop polling; **Rollback** button visible whenever `previous` exists. All new callbacks go through the existing `FleetDeps`/settings deps objects — **extend the deps interfaces, don't add imports** (web architecture rule), and update the `FleetDeps` literal in its test. DOM test asserts: no card without capability; card renders version; apply click POSTs and starts polling (fake `serverFetch`).
Commit: `feat(web): CC version card — check/update/rollback with status polling`.

### Task 9: Bridge managed install to the (still-SDK) driver

**Files:** Modify `anvild/src/main.ts` (startup, where config is loaded) · Test append to `anvild/test/unit/cc-install.test.ts`

```ts
// After loadConfig(): make the managed install the daemon's CLI even before Plan 3,
// via the seam that already exists (src/agent/cli.ts:14 reads ANVIL_CLI_PATH).
const ccBin = new CcInstalls(config.ccDir).currentBinary();
if (ccBin && !process.env.ANVIL_CLI_PATH) process.env.ANVIL_CLI_PATH = ccBin;
```
Unit test: with a fake activated install, a fresh env object fed through the same helper sets the path; an explicit pre-set `ANVIL_CLI_PATH` wins. (Extract the two lines into `export function bridgeCliPath(installs, env)` in `cc/install.ts` so the test doesn't mutate `process.env` — repo convention.)
Commit: `feat(cc): daemon prefers managed CC install via ANVIL_CLI_PATH bridge`.

**Phase acceptance (design §5.2):** on a machine with no managed CC: bootstrap via UI installs latest and activates after smoke; update to a newer version flips `current` only after smoke passes; induced smoke failure (point the downloader at a stub binary) leaves `current` untouched and reports `error`; rollback restores `previous`. Bootstrap = `apply()` on an empty store — Task 6's no-`current` path, verify in the Task 6 tests.
