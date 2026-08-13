// Guards plan-2 task 6's behavioral contract for the smoke-gated CC updater: phase
// ordering persisted to the state file, no-op on already-current, smoke failure leaves
// `current` untouched, concurrent applies coalesce, rollback swaps, corrupt state = idle.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcInstalls, binaryPath, type CcDownloader } from "../../src/cc/install";
import { CcUpdater, type CcUpdaterDeps } from "../../src/cc/update";
import type { SmokeOutcome } from "../../src/cc/smoke";

function plant(cc: CcInstalls, v: string): void {
  const dir = cc.installDirFor(v);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(binaryPath(dir), "#!/bin/sh\necho fake\n", { mode: 0o755 });
}

function harness(overrides: Partial<CcUpdaterDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "anvil-cc-upd-"));
  const installs = new CcInstalls(root);
  const downloads: string[] = [];
  const download: CcDownloader = async (version, destDir) => {
    downloads.push(version);
    mkdirSync(join(destDir, "bin"), { recursive: true });
    writeFileSync(binaryPath(destDir), "#!/bin/sh\necho fake\n", { mode: 0o755 });
    return { version };
  };
  const smoke = async (): Promise<SmokeOutcome> => ({ ok: true, version: "x", log: [] });
  const stateFile = join(root, "cc-update-state.json");
  const deps: CcUpdaterDeps = {
    installs,
    download,
    smoke: smoke as CcUpdaterDeps["smoke"],
    resolveLatest: async () => "2.2.0",
    stateFile,
    smokeCwd: root,
    ...overrides,
  };
  return { root, installs, downloads, deps, stateFile };
}

function fileState(stateFile: string): { phase: string } {
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

test("bootstrap: apply() on an empty store installs latest and lands healthy", async () => {
  const h = harness();
  const updater = new CcUpdater(h.deps);
  const st = await updater.apply();
  expect(st.phase).toBe("healthy");
  expect(h.installs.currentVersion()).toBe("2.2.0");
  expect(h.downloads).toEqual(["2.2.0"]);
  expect(fileState(h.stateFile).phase).toBe("healthy");
});

test("already-current target is an immediate healthy no-op (no download)", async () => {
  const h = harness();
  plant(h.installs, "2.2.0");
  h.installs.activate("2.2.0");
  const st = await new CcUpdater(h.deps).apply();
  expect(st.phase).toBe("healthy");
  expect(h.downloads).toEqual([]);
});

test("phases are persisted in order checking→downloading→smoking→flipping→healthy", async () => {
  const phases: string[] = [];
  let releaseDownload!: () => void;
  const downloadGate = new Promise<void>((r) => (releaseDownload = r));
  let releaseSmoke!: () => void;
  const smokeGate = new Promise<void>((r) => (releaseSmoke = r));
  const h = harness();
  const gatedDeps: CcUpdaterDeps = {
    ...h.deps,
    download: async (version, destDir) => {
      phases.push(fileState(h.stateFile).phase); // during download
      await downloadGate;
      return h.deps.download(version, destDir);
    },
    smoke: (async () => {
      phases.push(fileState(h.stateFile).phase); // during smoke
      await smokeGate;
      return { ok: true, log: [] };
    }) as CcUpdaterDeps["smoke"],
  };
  const updater = new CcUpdater(gatedDeps);
  const applied = updater.apply("2.2.0");
  releaseDownload();
  releaseSmoke();
  const st = await applied;
  expect(st.phase).toBe("healthy");
  expect(phases).toEqual(["downloading", "smoking"]);
  expect(fileState(h.stateFile).phase).toBe("healthy");
});

test("smoke failure ⇒ error, current untouched, downloaded dir retained", async () => {
  const h = harness({
    smoke: (async () => ({ ok: false, reason: "no auth", log: ["boom"] })) as CcUpdaterDeps["smoke"],
  });
  plant(h.installs, "2.1.0");
  h.installs.activate("2.1.0");
  const st = await new CcUpdater(h.deps).apply("2.2.0");
  expect(st.phase).toBe("error");
  expect(st.reason).toContain("no auth");
  expect(h.installs.currentVersion()).toBe("2.1.0"); // untouched
  expect(existsSync(binaryPath(h.installs.installDirFor("2.2.0")))).toBe(true); // kept for diagnosis
});

test("concurrent apply() coalesces into one download", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness();
  const slowDeps: CcUpdaterDeps = {
    ...h.deps,
    download: async (version, destDir) => {
      await gate;
      return h.deps.download(version, destDir);
    },
  };
  const updater = new CcUpdater(slowDeps);
  const a = updater.apply("2.2.0");
  const b = updater.apply("2.2.0");
  release();
  const [ra, rb] = await Promise.all([a, b]);
  expect(ra.phase).toBe("healthy");
  expect(rb.phase).toBe("healthy");
  expect(h.downloads).toEqual(["2.2.0"]); // one download, not two
});

test("rollback swaps to previous and reports rolled-back", async () => {
  const h = harness();
  plant(h.installs, "2.1.0");
  plant(h.installs, "2.2.0");
  h.installs.activate("2.1.0");
  h.installs.activate("2.2.0");
  const updater = new CcUpdater(h.deps);
  const st = updater.rollback();
  expect(st.phase).toBe("rolled-back");
  expect(h.installs.currentVersion()).toBe("2.1.0");
});

test("corrupt state file on boot is swallowed; status reports idle", () => {
  const h = harness();
  writeFileSync(h.stateFile, "{definitely not json");
  const updater = new CcUpdater(h.deps);
  expect(updater.status().phase).toBe("idle");
});

test("status() reports current/previous/installed alongside the phase", async () => {
  const h = harness();
  plant(h.installs, "2.1.0");
  h.installs.activate("2.1.0");
  const updater = new CcUpdater(h.deps);
  await updater.apply("2.2.0");
  const s = updater.status();
  expect(s.current).toBe("2.2.0");
  expect(s.previous).toBe("2.1.0");
  expect(s.installed).toEqual(["2.1.0", "2.2.0"]);
});

test("check() compares current to latest", async () => {
  const h = harness();
  plant(h.installs, "2.1.0");
  h.installs.activate("2.1.0");
  const updater = new CcUpdater(h.deps);
  expect(await updater.check()).toEqual({ current: "2.1.0", latest: "2.2.0", updateAvailable: true });
});
