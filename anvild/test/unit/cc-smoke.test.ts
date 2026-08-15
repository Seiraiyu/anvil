// Guards design §4.8's post-download gate: a candidate binary must report a semver and
// complete one trivial -p turn whose stream parses cleanly to init…result. Fake runners
// only — the live variant is cc-smoke.live.test.ts (CC_SMOKE_LIVE=1).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { smokeTest } from "../../src/cc/smoke";
import type { CommandRunner } from "../../src/cc/install";

const BASIC = readFileSync(join(import.meta.dir, "..", "fixtures", "cc", "basic.ndjson"), "utf8");

function runner(turnOut: string, opts: { versionOut?: string; turnCode?: number } = {}): CommandRunner {
  return async (cmd) => {
    if (cmd.includes("--version")) return { code: 0, out: opts.versionOut ?? "2.1.231 (Claude Code)" };
    return { code: opts.turnCode ?? 0, out: turnOut };
  };
}

test("golden-recording output passes the gate and reports the version", async () => {
  const out = await smokeTest("/fake/claude", { cwd: "/tmp", run: runner(BASIC) });
  expect(out.ok).toBe(true);
  expect(out.version).toBe("2.1.231");
});

test("a binary with no semver in --version fails closed", async () => {
  const out = await smokeTest("/fake/claude", { cwd: "/tmp", run: runner(BASIC, { versionOut: "flagrantly not a version" }) });
  expect(out.ok).toBe(false);
  expect(out.reason).toContain("--version");
});

test("garbage stream output fails closed with the parse warn as reason", async () => {
  const out = await smokeTest("/fake/claude", { cwd: "/tmp", run: runner("{not json\n") });
  expect(out.ok).toBe(false);
  expect(out.reason).toContain("unparseable");
});

test("a stream not ending in a result fails closed", async () => {
  const out = await smokeTest("/fake/claude", { cwd: "/tmp", run: runner('{"type":"system","subtype":"init","session_id":"s"}\n') });
  expect(out.ok).toBe(false);
  expect(out.reason).toContain("result");
});

test("nonzero exit fails closed with the output tail in the log", async () => {
  const out = await smokeTest("/fake/claude", { cwd: "/tmp", run: runner("auth boom", { turnCode: 1 }) });
  expect(out.ok).toBe(false);
  expect(out.log.join("\n")).toContain("auth boom");
});
