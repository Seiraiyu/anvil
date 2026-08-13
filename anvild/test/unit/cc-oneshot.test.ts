/**
 * cc/oneshot.ts against the REAL fake-CC child (test/helpers/fake-cc.ts) — no subprocess mocks.
 * These pin the runAgentQuery-replacement contract (cc plan 7 tasks 1+5): spawn args (model /
 * permission-mode / guard --settings), env profile selection per ModelSpec, ExitPlanMode plan
 * capture, abort teardown, and the micro-query's no-tools flag + timeout.
 */
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCcQuery, runCcMicroQuery, writeGuardOverlay } from "../../src/cc/oneshot";
import { CLAUDE, GLM } from "../../src/agent/model-roster";
import { OPENROUTER_ANTHROPIC_BASE_URL } from "../../src/agent/env";

const FAKE_CC = join(import.meta.dir, "..", "helpers", "fake-cc.ts");
const PLAN_FIXTURE = join(import.meta.dir, "..", "fixtures", "oneshot", "oneshot-plan.ndjson");
const CANNED_PLAN = "# Plan\n\nChange src/x.ts to do the thing.";

const ORIG = { c: process.env.CLAUDE_CODE_OAUTH_TOKEN, o: process.env.OPENROUTER_API_KEY };
const tmpDirs: string[] = [];
afterEach(() => {
  if (ORIG.c === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG.c;
  if (ORIG.o === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIG.o;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "oneshot-test-"));
  tmpDirs.push(d);
  return d;
}

test("Claude spec: plan-mode spawn carries model/permission/guard settings and captures plan + text", async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-x";
  const d = scratch();
  const argsFile = join(d, "args.json");
  const stdinFile = join(d, "stdin.txt");
  const envFile = join(d, "env.json");

  const res = await runCcQuery("plan it", {
    model: CLAUDE,
    readonly: true,
    cwd: d,
    ccCommand: ["bun", FAKE_CC],
    extraEnv: {
      FAKE_CC_FIXTURE: PLAN_FIXTURE,
      FAKE_CC_ARGS_FILE: argsFile,
      FAKE_CC_STDIN_FILE: stdinFile,
      FAKE_CC_ENV_FILE: envFile,
    },
  });
  expect(res.plan).toBe(CANNED_PLAN);
  expect(res.text).toBe("The plan is ready.");

  const args: string[] = JSON.parse(readFileSync(argsFile, "utf8"));
  expect(args).toContain("-p");
  expect(args.slice(args.indexOf("--model"))[1]).toBe("opus");
  expect(args.slice(args.indexOf("--permission-mode"))[1]).toBe("plan");
  // [SEC-H4] every one-shot rides the guard overlay
  const settingsPath = args.slice(args.indexOf("--settings"))[1]!;
  expect(settingsPath.endsWith("settings.json")).toBe(true);

  // env profile: subscription token, no OpenRouter base URL
  const env: Record<string, string> = JSON.parse(readFileSync(envFile, "utf8"));
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-x");
  expect(env.ANTHROPIC_BASE_URL).toBeUndefined();

  // stdin carried exactly one stream-json user message with the prompt
  const msg = JSON.parse(readFileSync(stdinFile, "utf8").trim());
  expect(msg.type).toBe("user");
  expect(msg.message.content).toBe("plan it");
});

test("GLM spec drives the SAME path with the GLM slug and the OpenRouter Anthropic-Skin env", async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-v1-k";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const d = scratch();
  const argsFile = join(d, "args.json");
  const envFile = join(d, "env.json");

  const res = await runCcQuery("implement it", {
    model: GLM,
    ccCommand: ["bun", FAKE_CC],
    extraEnv: { FAKE_CC_FIXTURE: PLAN_FIXTURE, FAKE_CC_ARGS_FILE: argsFile, FAKE_CC_ENV_FILE: envFile },
  });
  expect(res.text).toBe("The plan is ready.");

  const args: string[] = JSON.parse(readFileSync(argsFile, "utf8"));
  expect(args.slice(args.indexOf("--model"))[1]).toBe("z-ai/glm-5.2");
  expect(args.slice(args.indexOf("--permission-mode"))[1]).toBe("default");

  const env: Record<string, string> = JSON.parse(readFileSync(envFile, "utf8"));
  expect(env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_ANTHROPIC_BASE_URL);
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-v1-k");
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
});

test("the guard overlay wires a PreToolUse command hook at the generated script", () => {
  const d = scratch();
  const settingsPath = writeGuardOverlay(d, "/worktree");
  const overlay = JSON.parse(readFileSync(settingsPath, "utf8"));
  const hook = overlay.hooks.PreToolUse[0].hooks[0];
  expect(hook.type).toBe("command");
  expect(hook.command).toContain("guard-hook.mjs");
  expect(hook.timeout).toBe(3600);
  expect(existsSync(join(d, "guard-hook.mjs"))).toBe(true);
});

test("abort mid-stream kills the child group and throws", async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-x";
  const ac = new AbortController();
  const run = runCcQuery("hang", {
    model: CLAUDE,
    signal: ac.signal,
    ccCommand: ["bun", FAKE_CC],
    extraEnv: { FAKE_CC_FIXTURE: PLAN_FIXTURE, FAKE_CC_HANG_AFTER: "1" },
  });
  setTimeout(() => ac.abort(), 150);
  await expect(run).rejects.toThrow(/aborted/);
});

test("a nonzero exit without a result throws with the stderr tail", async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-x";
  await expect(
    runCcQuery("x", {
      model: CLAUDE,
      ccCommand: ["bun", FAKE_CC],
      extraEnv: { FAKE_CC_ERROR: "resume rejected: boom" },
    }),
  ).rejects.toThrow(/boom/);
});

test("runCcMicroQuery: no-tools single turn returns the assistant text", async () => {
  const d = scratch();
  const argsFile = join(d, "args.json");
  const out = await runCcMicroQuery("Reply with ok", {
    model: "haiku",
    env: { PATH: process.env.PATH ?? "" },
    ccCommand: ["bun", FAKE_CC],
    extraEnv: { FAKE_CC_ARGS_FILE: argsFile }, // default fixture: basic.ndjson → "ok"
  });
  expect(out).toBe("ok");

  const args: string[] = JSON.parse(readFileSync(argsFile, "utf8"));
  expect(args.slice(args.indexOf("--model"))[1]).toBe("haiku");
  expect(args.slice(args.indexOf("--tools"))[1]).toBe(""); // all tools disabled
  expect(args).not.toContain("--settings"); // micro-queries need no guard: nothing to gate
});

test("runCcMicroQuery: hard timeout kills the child and throws", async () => {
  await expect(
    runCcMicroQuery("hang forever", {
      model: "haiku",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 300,
      ccCommand: ["bun", FAKE_CC],
      extraEnv: { FAKE_CC_HANG_AFTER: "0" },
    }),
  ).rejects.toThrow(/timed out/);
});
