/**
 * The /api/cc/v1/* CONTRACT test (plan 2 task 7, mirroring update-api-contract.test.ts).
 * The surface is FROZEN additive-only: every required field below must stay present with
 * its type; extras are allowed. A failure here is a BREAKING change — do not edit the
 * expectations to match; bump to /api/cc/v2 + CC_API_VERSION instead.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerHandle } from "../../src/server/http";
import { CcInstalls, binaryPath, type CcDownloader } from "../../src/cc/install";
import { CcUpdater, CC_API_VERSION, type CcUpdaterDeps } from "../../src/cc/update";

// Frozen required fields per response (name → [field, jstype][]).
const SHAPES: Record<string, [string, string][]> = {
  status: [
    ["ccApiVersion", "number"],
    ["phase", "string"],
    ["updatedAt", "string"],
    ["installed", "array"],
  ],
  check: [
    ["ccApiVersion", "number"],
    ["latest", "string"],
    ["updateAvailable", "boolean"],
  ],
};

function assertShape(obj: Record<string, unknown>, shape: keyof typeof SHAPES): void {
  for (const [key, want] of SHAPES[shape]!) {
    expect(obj, `cc/v1 ${String(shape)}.${key} is a FROZEN required field`).toHaveProperty(key);
    const got = obj[key];
    const ok = want === "array" ? Array.isArray(got) : typeof got === want;
    expect(ok, `cc/v1 ${String(shape)}.${key} must be ${want}`).toBe(true);
  }
}

function fakeUpdater(root: string): { updater: CcUpdater; installs: CcInstalls } {
  const installs = new CcInstalls(join(root, "cc"));
  const download: CcDownloader = async (version, destDir) => {
    mkdirSync(join(destDir, "bin"), { recursive: true });
    writeFileSync(binaryPath(destDir), "#!/bin/sh\necho fake\n", { mode: 0o755 });
    return { version };
  };
  const deps: CcUpdaterDeps = {
    installs,
    download,
    smoke: (async () => ({ ok: true, log: [] })) as CcUpdaterDeps["smoke"],
    resolveLatest: async () => "2.9.9",
    stateFile: join(root, "cc-update-state.json"),
    smokeCwd: root,
  };
  return { updater: new CcUpdater(deps), installs };
}

let srv: ServerHandle;
let stateDir: string;
let installs: CcInstalls;
beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "anvil-cc-contract-"));
  const fake = fakeUpdater(stateDir);
  installs = fake.installs;
  srv = createServer({ port: 0, stateDir, ccUpdater: fake.updater });
});
afterAll(async () => {
  await srv.shutdown();
  rmSync(stateDir, { recursive: true, force: true });
});

test("[live] GET /api/cc/v1/status conforms and starts idle", async () => {
  const r = await fetch(`http://localhost:${srv.port}/api/cc/v1/status`);
  expect(r.status).toBe(200);
  const body = (await r.json()) as Record<string, unknown>;
  assertShape(body, "status");
  expect(body.ccApiVersion).toBe(CC_API_VERSION);
  expect(body.phase).toBe("idle");
});

test("[live] GET /api/cc/v1/check conforms", async () => {
  const r = await fetch(`http://localhost:${srv.port}/api/cc/v1/check`);
  expect(r.status).toBe(200);
  const body = (await r.json()) as Record<string, unknown>;
  assertShape(body, "check");
  expect(body.latest).toBe("2.9.9");
});

test("[live] POST /api/cc/v1/apply requires JSON content-type ([SEC2-2])", async () => {
  const r = await fetch(`http://localhost:${srv.port}/api/cc/v1/apply`, { method: "POST", body: "x" });
  expect(r.status).toBe(415);
});

test("[live] POST apply kicks the flow, returns status immediately, and status polls to healthy", async () => {
  const r = await fetch(`http://localhost:${srv.port}/api/cc/v1/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(r.status).toBe(200);
  assertShape((await r.json()) as Record<string, unknown>, "status");
  // Poll until terminal (fake deps resolve in microtasks; a handful of polls suffices).
  let phase = "";
  for (let i = 0; i < 50 && phase !== "healthy"; i++) {
    const s = (await (await fetch(`http://localhost:${srv.port}/api/cc/v1/status`)).json()) as { phase: string };
    phase = s.phase;
    if (phase !== "healthy") await new Promise((res) => setTimeout(res, 10));
  }
  expect(phase).toBe("healthy");
  expect(installs.currentVersion()).toBe("2.9.9");
});

test("[live] POST rollback with no previous is a clean 409; with previous it swaps", async () => {
  const r409 = await fetch(`http://localhost:${srv.port}/api/cc/v1/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(r409.status).toBe(409);

  // Install + activate an older version so `previous` exists, then roll back to it.
  const dir = installs.installDirFor("2.0.0");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(binaryPath(dir), "#!/bin/sh\necho fake\n", { mode: 0o755 });
  installs.activate("2.0.0"); // 2.9.9 (current from the apply test) becomes previous
  const r = await fetch(`http://localhost:${srv.port}/api/cc/v1/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as Record<string, unknown>;
  assertShape(body, "status");
  expect(body.phase).toBe("rolled-back");
  expect(installs.currentVersion()).toBe("2.9.9");
});
