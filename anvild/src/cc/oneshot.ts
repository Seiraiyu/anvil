/**
 * CLI-direct one-shot queries (cc-cli-transport design §4.6): the `runAgentQuery` replacement for
 * the pipeline, autopilot planning, and the micro-classifiers. Spawns the CC CLI `-p` per call —
 * no resume, one prompt in, one result out — through the same golden-pinned stream parser and
 * procgroup discipline the turn-runner uses.
 *
 * Two primitives:
 *  - `runCcQuery`: the dual-model pipeline/autopilot path. `ModelSpec` selects both the CLI
 *    `--model` id and the env profile (Claude subscription vs GLM over OpenRouter's Anthropic
 *    Skin — agent/env.ts), so authorship can flip by phase with env-only differences. `readonly`
 *    runs `--permission-mode plan`; the plan is captured from the `ExitPlanMode` tool_use
 *    `input.plan` in the stream and `text` from the closing result. Every run writes a per-run
 *    `--settings` overlay installing the [SEC-H4] guard hook (agent/pipeline-guard.ts) — it
 *    denies the danger list AND supplies the allow decisions an unattended run needs to approve
 *    `ExitPlanMode`/tool use at all.
 *  - `runCcMicroQuery`: the tiny single-turn classifiers (branch-kind, goal judge, icon).
 *    `--tools ""` disables all tools (the CLI's documented no-tools mode — stronger than the old
 *    SDK `allowedTools: []`, and what guarantees a single turn), so no guard overlay is needed.
 *
 * Deliberate change from the SDK path (plan 7 task 1): NO `settingSources` isolation — one-shots
 * are fully CC-native like interactive sessions, loading the user's CLAUDE.md/settings/plugins.
 * Unattended safety comes from the guard hook, not from hiding config. Do not re-add isolation.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildAgentEnv } from "../agent/env";
import { userMessage } from "../agent/attachments";
import type { ModelSpec } from "../agent/model-roster";
import { renderGuardHookScript } from "../agent/pipeline-guard";
import type { AccountStore } from "../auth/accounts";
import { spawnInGroup, killGroup, type Group } from "../session/procgroup";
import { NdjsonSplitter, parseCCLine, type CCMessage } from "./stream";
import { resolveCcCommand } from "./install";

/** What a one-shot returns. (The successor to agent/query.ts's AgentQueryResult.) */
export interface AgentQueryResult {
  text: string;
  plan?: string;
}

export interface CcQueryOpts {
  model: ModelSpec;
  cwd?: string;
  /** `--permission-mode plan`: reads/greps allowed, edits blocked; plan via ExitPlanMode. */
  readonly?: boolean;
  /** Aborting kills the child's process group (SIGINT → grace → SIGKILL) and throws. */
  signal?: AbortSignal;
  /** The Claude account roster + which account this run bills to (multi-account §6). Absent ⇒ the
   *  pre-roster env-var path. */
  accounts?: AccountStore;
  accountId?: string;
  /** Test seam: the CC binary vector (["bun", fake-cc.ts] in tests). Default: ANVIL_CLI_PATH
   *  (the plan-2 managed-install bridge) or PATH's `claude`. */
  ccCommand?: string[];
  /** Test seam: extra child env (FAKE_CC_* config) merged over the §3 allow-list. */
  extraEnv?: Record<string, string>;
}

/** The fake-cc test seam every one-shot caller threads through (never set in prod). */
export type CcSeam = Pick<CcQueryOpts, "ccCommand" | "extraEnv">;

/** The interpreter for the generated guard hook: this daemon's own bun when we're running under
 *  one (robust against PATH surprises), else a bare `bun` resolved from the child's PATH. */
function bunBin(): string {
  return /^bun/.test(basename(process.execPath)) ? process.execPath : "bun";
}

/** Single-quote a path for the hook's shell command line (mkdtemp paths never contain quotes). */
const sq = (s: string) => `'${s}'`;

/** Write the per-run guard: hook script + `--settings` overlay. Exported for the equivalence test. */
export function writeGuardOverlay(dir: string, cwd?: string): string {
  const scriptPath = join(dir, "guard-hook.mjs");
  writeFileSync(scriptPath, renderGuardHookScript(cwd));
  const overlay = {
    hooks: {
      // 3600s matches the old SDK hook timeout (a long tool call must not outlive its gate).
      PreToolUse: [{ hooks: [{ type: "command", command: `${sq(bunBin())} ${sq(scriptPath)}`, timeout: 3600 }] }],
    },
  };
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(overlay, null, 2));
  return settingsPath;
}

interface StreamOutcome {
  text: string;
  plan?: string;
  sawResult: boolean;
}

/** Drive one spawned CC CLI to exit, collecting result text + ExitPlanMode plan + assistant text. */
async function collect(
  group: Group,
  prompt: string,
  stderrTail: string[],
): Promise<StreamOutcome & { code: number | null; assistantText: string }> {
  // One user message, then EOF — stdin-close is the -p turn boundary (same as the turn-runner).
  group.child.stdin!.write(`${JSON.stringify(userMessage(prompt))}\n`);
  group.child.stdin!.end();

  let text = "";
  let plan: string | undefined;
  let assistantText = "";
  let sawResult = false;

  const handle = (line: string): void => {
    const { msg } = parseCCLine(line);
    if (!msg) return;
    const m = msg as CCMessage;
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const block of m.message.content as { type?: string; name?: string; text?: string; input?: { plan?: unknown } }[]) {
        if (block.type === "tool_use" && block.name === "ExitPlanMode") {
          const p = block.input?.plan;
          if (typeof p === "string" && p.trim()) plan = p.trim();
        }
        if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
      }
    }
    if (m.type === "result") {
      sawResult = true;
      if (typeof m.result === "string") text = m.result;
    }
  };

  const splitter = new NdjsonSplitter();
  group.child.stdout!.setEncoding("utf8");
  group.child.stdout!.on("data", (chunk: string) => {
    for (const line of splitter.push(chunk)) handle(line);
  });
  // 'exit' can fire BEFORE the pipe's final buffered chunks are delivered — waiting on stdout
  // 'close' too keeps the last line (usually the `result` message) from being silently lost.
  const stdoutClosed = new Promise<void>((r) => group.child.stdout!.once("close", () => r()));
  group.child.stderr!.setEncoding("utf8");
  group.child.stderr!.on("data", (chunk: string) => {
    stderrTail.push(chunk);
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const code = await group.exited;
  await stdoutClosed;
  const tail = splitter.flush();
  if (tail) handle(tail); // a CLI that died mid-line still gets its last words parsed

  return { text, plan, sawResult, code, assistantText };
}

/**
 * Run one dual-model one-shot. Throws on abort and on a nonzero exit that produced no result;
 * callers (pipeline phases, autopilot) treat throws per their own escalation/fail-open rules.
 */
export async function runCcQuery(prompt: string, opts: CcQueryOpts): Promise<AgentQueryResult> {
  if (opts.signal?.aborted) throw new Error("one-shot aborted before start");
  const runDir = mkdtempSync(join(tmpdir(), "anvil-oneshot-"));
  try {
    const settingsPath = writeGuardOverlay(runDir, opts.cwd);
    // Built per-call so the right provider/token drives this spawn, and so a key set/reset via the
    // UI reaches the next run without a daemon restart.
    const env = {
      ...buildAgentEnv({ profile: opts.model.profile, accounts: opts.accounts, accountId: opts.accountId }),
      ...opts.extraEnv,
    };
    env.TMPDIR = env.TMPDIR ?? tmpdir();

    const cmd = opts.ccCommand ?? resolveCcCommand(process.env);
    const args = [
      ...cmd.slice(1),
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--model", opts.model.sdkModel,
      "--permission-mode", opts.readonly ? "plan" : "default",
      "--settings", settingsPath,
    ];

    const group = spawnInGroup(cmd[0]!, args, { cwd: opts.cwd, env, stdio: "pipe" });
    const onAbort = () => void killGroup(group, 5000, "SIGINT");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const stderrTail: string[] = [];
    try {
      const r = await collect(group, prompt, stderrTail);
      if (opts.signal?.aborted) throw new Error("one-shot aborted");
      if (!r.sawResult && r.code !== 0) {
        throw new Error(`claude exited ${r.code ?? "by signal"}: ${stderrTail.join("").trim().slice(-800)}`);
      }
      return { text: r.text.trim(), ...(r.plan ? { plan: r.plan } : {}) };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      await killGroup(group, 1000, "SIGKILL"); // no-op when already exited; reaps a wedged tree
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

export interface CcMicroQueryOpts {
  /** A CLI model id or alias (`haiku`, `sonnet` — the classifiers' whole vocabulary). */
  model: string;
  /** The §3 allow-list env the caller already built (buildAgentEnv). */
  env: Record<string, string>;
  /** Hard deadline; the child group is killed and the call throws. Default 20s. */
  timeoutMs?: number;
  /** Test seams — see CcQueryOpts. */
  ccCommand?: string[];
  extraEnv?: Record<string, string>;
}

/**
 * Run one tiny no-tools classification turn and return the model's reply text. Throws on
 * timeout or a failed spawn — every caller treats that as its heuristic/fail-open fallback.
 */
export async function runCcMicroQuery(prompt: string, opts: CcMicroQueryOpts): Promise<string> {
  const env = { ...opts.env, ...opts.extraEnv };
  env.TMPDIR = env.TMPDIR ?? tmpdir();
  const cmd = opts.ccCommand ?? resolveCcCommand(process.env);
  const args = [
    ...cmd.slice(1),
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--model", opts.model,
    "--tools", "", // the documented "disable all tools" form — text-only, so exactly one turn
  ];

  const group = spawnInGroup(cmd[0]!, args, { env, stdio: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killGroup(group, 1000, "SIGINT");
  }, opts.timeoutMs ?? 20_000);

  const stderrTail: string[] = [];
  try {
    const r = await collect(group, prompt, stderrTail);
    if (timedOut) throw new Error(`micro-query timed out after ${opts.timeoutMs ?? 20_000}ms`);
    if (!r.sawResult && r.code !== 0) {
      throw new Error(`claude exited ${r.code ?? "by signal"}: ${stderrTail.join("").trim().slice(-800)}`);
    }
    // The classifiers read the assistant's prose; fall back to the result text (identical for
    // text-only turns) so an empty assistant echo can't turn a good verdict into a miss.
    return (r.assistantText || r.text).trim();
  } finally {
    clearTimeout(timer);
    await killGroup(group, 1000, "SIGKILL");
  }
}
