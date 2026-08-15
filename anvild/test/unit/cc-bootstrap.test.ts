// Guards design §4.8's first-run bootstrap and §5.9's "a fresh install reaches a working session"
// (cc plan 9 task 1). Real temp dirs + real symlinks (repo convention: never fake the filesystem);
// the PATH probe and the updater are injected so no test ever downloads a CLI.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcInstalls, binaryPath } from "../../src/cc/install";
import { CcBootstrap, CcBootstrapError, ensureCcAvailable, registerCcBootstrap } from "../../src/cc/bootstrap";

function store(): CcInstalls {
  return new CcInstalls(mkdtempSync(join(tmpdir(), "anvil-cc-bootstrap-")));
}
function fakeInstall(cc: CcInstalls, v: string): void {
  const dir = cc.installDirFor(v);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(binaryPath(dir), "#!/bin/sh\necho fake\n", { mode: 0o755 });
}
/** A bootstrap whose PATH has no `claude` and whose apply() is counted. */
function harness(opts: { installs?: CcInstalls; onPath?: () => string | null; apply?: () => Promise<{ phase: string; reason?: string }> } = {}) {
  const installs = opts.installs ?? store();
  const env: Record<string, string | undefined> = {};
  let applies = 0;
  const apply = async () => {
    applies++;
    return opts.apply ? await opts.apply() : { phase: "healthy" };
  };
  const bootstrap = new CcBootstrap({
    installs,
    apply,
    env,
    onPath: opts.onPath ?? (() => null),
    log: () => {},
  });
  return { bootstrap, installs, env, applies: () => applies };
}

afterEach(() => registerCcBootstrap(null));

test("a `claude` already on PATH is enough — nothing is downloaded", async () => {
  const h = harness({ onPath: () => "/usr/local/bin/claude" });
  await h.bootstrap.ensure();
  expect(h.applies()).toBe(0);
  expect(h.env.ANVIL_CLI_PATH).toBeUndefined(); // PATH resolution stays PATH resolution
});

test("an activated managed install is adopted into ANVIL_CLI_PATH — nothing is downloaded", async () => {
  const installs = store();
  fakeInstall(installs, "2.1.233");
  installs.activate("2.1.233");
  const h = harness({ installs });
  await h.bootstrap.ensure();
  expect(h.applies()).toBe(0);
  expect(h.env.ANVIL_CLI_PATH).toBe(binaryPath(installs.installDirFor("2.1.233")));
});

test("no install and no PATH claude: applies once, then adopts what it activated", async () => {
  const installs = store();
  const h = harness({
    installs,
    apply: async () => {
      // What the real CcUpdater.apply does on success: download, smoke, flip `current`.
      fakeInstall(installs, "2.1.233");
      installs.activate("2.1.233");
      return { phase: "healthy" };
    },
  });
  await h.bootstrap.ensure();
  expect(h.applies()).toBe(1);
  expect(h.env.ANVIL_CLI_PATH).toBe(binaryPath(installs.installDirFor("2.1.233")));
});

test("bootstrap is latched: a second ensure() after success does not re-apply", async () => {
  const installs = store();
  const h = harness({
    installs,
    apply: async () => {
      fakeInstall(installs, "2.1.233");
      installs.activate("2.1.233");
      return { phase: "healthy" };
    },
  });
  await h.bootstrap.ensure();
  await h.bootstrap.ensure();
  expect(h.applies()).toBe(1);
});

test("concurrent turns on a fresh machine bootstrap once, not N times", async () => {
  const installs = store();
  const h = harness({
    installs,
    apply: async () => {
      await new Promise((r) => setTimeout(r, 10)); // a real download is not instant
      fakeInstall(installs, "2.1.233");
      installs.activate("2.1.233");
      return { phase: "healthy" };
    },
  });
  await Promise.all([h.bootstrap.ensure(), h.bootstrap.ensure(), h.bootstrap.ensure()]);
  expect(h.applies()).toBe(1);
});

test("a failed apply throws CcBootstrapError carrying the phase reason", async () => {
  const h = harness({ apply: async () => ({ phase: "error", reason: "smoke failed: exit 1" }) });
  await expect(h.bootstrap.ensure()).rejects.toThrow(CcBootstrapError);
  await expect(h.bootstrap.ensure()).rejects.toThrow(/smoke failed: exit 1/);
});

test("a failed bootstrap is retried on the next turn (not latched)", async () => {
  const installs = store();
  let attempt = 0;
  const h = harness({
    installs,
    apply: async () => {
      if (++attempt === 1) return { phase: "error", reason: "network down" };
      fakeInstall(installs, "2.1.233");
      installs.activate("2.1.233");
      return { phase: "healthy" };
    },
  });
  await expect(h.bootstrap.ensure()).rejects.toThrow(CcBootstrapError);
  await h.bootstrap.ensure(); // the machine came back online
  expect(h.applies()).toBe(2);
});

test("an explicit ANVIL_CLI_PATH wins; a broken one fails loudly instead of downloading over it", async () => {
  const installs = store();
  const env: Record<string, string | undefined> = { ANVIL_CLI_PATH: "/nope/claude" };
  let applies = 0;
  const bootstrap = new CcBootstrap({
    installs,
    apply: async () => { applies++; return { phase: "healthy" }; },
    env,
    onPath: () => "/usr/local/bin/claude", // even with a usable PATH claude, the override rules
    log: () => {},
  });
  await expect(bootstrap.ensure()).rejects.toThrow(/ANVIL_CLI_PATH points at a missing binary/);
  expect(applies).toBe(0); // bridgeCliPath would never overwrite it, so downloading is pointless
});

test("ensureCcAvailable is a no-op until a bootstrap is registered", async () => {
  await ensureCcAvailable(); // unregistered: must not throw, must not download
  const h = harness();
  registerCcBootstrap(h.bootstrap);
  await expect(ensureCcAvailable()).rejects.toThrow(CcBootstrapError);
  expect(h.applies()).toBe(1);
});
