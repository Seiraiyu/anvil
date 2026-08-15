// Live smoke against the real `claude` on PATH — proves the gate's CLI invocation is
// accepted by a current binary. SKIPPED by default (needs an authenticated claude; costs
// one haiku turn). Run locally with:
//   CC_SMOKE_LIVE=1 bun test test/unit/cc-smoke.live.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smokeTest } from "../../src/cc/smoke";

const LIVE = process.env.CC_SMOKE_LIVE === "1";

test.skipIf(!LIVE)("real claude passes the smoke gate", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "anvil-cc-smoke-"));
  const out = await smokeTest("claude", { cwd });
  expect(out.reason).toBeUndefined();
  expect(out.ok).toBe(true);
  expect(out.version).toMatch(/^\d+\.\d+\.\d+/);
}, 180_000);
