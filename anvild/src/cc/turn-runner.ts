/**
 * CLI-direct session driver (cc-cli-transport design §4.1/§4.2): drives one Anvil session by
 * spawning the Claude Code CLI per turn — `-p --output-format stream-json` — instead of the
 * Agent SDK's long-lived query. Turn lifecycle:
 *
 *   idle → spawning → streaming → settling → idle          (plus `error` on a failed turn)
 *
 * One in-flight turn per session; prompts arriving mid-turn queue FIFO in the daemon (this
 * replaces the SDK path's InputQueue). The first turn records the CLI's session id from
 * `system/init`; every later turn passes `--resume <id>` — context lives with the CLI, so
 * `claude --resume <id>` works from a terminal too. Interrupt = SIGINT to the process group,
 * grace, then SIGKILL (procgroup discipline). The stdout NDJSON stream flows through the
 * golden-pinned parser (cc/stream.ts) and the shared mapper (agent/map.ts); the flush() tail
 * is parsed too, so a CLI that dies mid-line still surfaces what it said.
 *
 * Permission brokering and daemon MCP tools join in Plans 4–5 — until then the CLI runs with
 * its own default permission engine ("default" mode: read-only tools work, mutating tools are
 * denied in -p mode).
 */
import { tmpdir } from "node:os";
import type { CommandInfo, ContentBlock, Model } from "@protocol";
import { sdkModelId } from "../agent/models";
import { userMessage, type InlineAttachment } from "../agent/input-queue";
import { askUserQuestionToolIds, extractResultUsage, extractSessionId, mapMessage } from "../agent/map";
import { buildCommandInfo } from "../agent/skills";
import { buildFileOffer, deliverablePath, maybeTaildrop } from "../agent/file-offer";
import { isResumeRejectedError, type ResultRecorder } from "../agent/driver";
import { GOAL_TRANSCRIPT_LINES } from "../agent/goal";
import { NdjsonSplitter, parseCCLine, type CCMessage } from "./stream";
import { spawnInGroup, killGroup, type Group } from "../session/procgroup";
import type { Session } from "../session/session";
import type { MarkdownRenderer } from "../render/markdown";

/** The supervisor-facing driver surface — AgentDriver (SDK) and TurnRunner (CLI) both satisfy it. */
export interface SessionDriver {
  prompt(text: string, attachments?: InlineAttachment[]): void;
  interrupt(): Promise<void>;
  setModel(model: Model): Promise<void>;
  stop(): Promise<void>;
}

export type TurnState = "idle" | "spawning" | "streaming" | "settling" | "error";

export interface TurnRunnerDeps {
  session: Session;
  renderer: MarkdownRenderer;
  /** §3 allow-list env (agentEnv) — includes PATH, so a bare "claude" resolves. */
  env: Record<string, string>;
  onResult: ResultRecorder;
  onCommands?: (commands: CommandInfo[]) => void;
  onTurnError?: (err: unknown) => void;
  /** Command vector for the CC binary. Default: [$ANVIL_CLI_PATH] (the plan-2 managed-install
   *  bridge) or ["claude"] from PATH. Tests point this at the fake harness (["bun", fake-cc.ts]). */
  ccCommand?: string[];
  /** CLI permission engine mode until Plans 4–5 wire the daemon broker. */
  permissionMode?: string;
  /** SIGINT → this grace → SIGKILL (design decision: 5s). */
  interruptGraceMs?: number;
}

interface QueuedPrompt {
  text: string;
  attachments: InlineAttachment[];
}

/** Compact a token count for a human-facing divider: 1234 → "1.2k", 987 → "987". */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function resolveCcCommand(env: Record<string, string | undefined>): string[] {
  const cli = env.ANVIL_CLI_PATH?.trim();
  return cli ? [cli] : ["claude"];
}

export class TurnRunner implements SessionDriver {
  private state: TurnState = "idle";
  private readonly queue: QueuedPrompt[] = [];
  private group: Group | undefined;
  private closed = false;
  private interrupting = false;
  private startedWithResume = false;

  /** tool_use ids of in-flight AskUserQuestions — their tool.result (answers echo) is dropped. */
  private readonly askQuestionIds = new Set<string>();
  /** Deliverable writes pending a successful tool.result → download card (UI refinement §8). */
  private readonly pendingOffers = new Map<string, string>();

  constructor(private readonly deps: TurnRunnerDeps) {}

  /** Exposed for lifecycle tests. */
  get turnState(): TurnState {
    return this.state;
  }

  prompt(text: string, attachments: InlineAttachment[] = []): void {
    if (this.closed) return;
    this.queue.push({ text, attachments });
    this.deps.session.setStatus("thinking");
    if (this.state === "idle" || this.state === "error") void this.runNext();
  }

  async interrupt(): Promise<void> {
    const group = this.group;
    if (!group) return;
    this.interrupting = true;
    // SIGINT is the CLI's graceful interrupt; a wedged child (or one that shields the group)
    // is SIGKILLed after the grace. Group signal, so tool subprocesses die with it.
    await killGroup(group, this.deps.interruptGraceMs ?? 5000, "SIGINT");
    await group.exited;
  }

  /** The next spawn reads session.data.model (the supervisor records it before calling us). */
  async setModel(_model: Model): Promise<void> {}

  async stop(): Promise<void> {
    this.closed = true;
    this.queue.length = 0;
    await this.interrupt();
  }

  private async runNext(): Promise<void> {
    const next = this.queue.shift();
    if (!next || this.closed) return;
    const s = this.deps.session;
    this.state = "spawning";
    this.interrupting = false;
    this.startedWithResume = !!s.data.claudeSessionId;

    const cmd = this.deps.ccCommand ?? resolveCcCommand(this.deps.env);
    const args = [
      ...cmd.slice(1),
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", sdkModelId(s.data.model),
      "--permission-mode", this.deps.permissionMode ?? "default",
      // The daemon — not the host machine's ambient Claude config — is the authority (arch §6.6):
      // no user/project settings (hooks/plugins), no ambient MCP servers. Mirrors the SDK path's
      // settingSources: [] and keeps `init` the first stream line (plan-1 finding).
      "--setting-sources", "",
      "--strict-mcp-config",
      ...(this.systemPromptAppend() ? ["--append-system-prompt", this.systemPromptAppend()] : []),
      ...(s.data.claudeSessionId ? ["--resume", s.data.claudeSessionId] : []),
    ];

    let sawResult = false;
    const stderrTail: string[] = [];
    try {
      const group = spawnInGroup(cmd[0]!, args, {
        cwd: s.data.cwd,
        env: { ...this.deps.env, TMPDIR: this.deps.env.TMPDIR ?? tmpdir() },
        stdio: "pipe",
      });
      this.group = group;

      // One user message per turn, then EOF — stdin-close is the turn boundary (Assumption 5,
      // verified by the plan-1 recordings' -p flow). Shape ported from input-queue.userMessage.
      group.child.stdin!.write(`${JSON.stringify(userMessage(next.text, next.attachments))}\n`);
      group.child.stdin!.end();
      this.state = "streaming";

      const splitter = new NdjsonSplitter();
      group.child.stdout!.setEncoding("utf8");
      group.child.stdout!.on("data", (chunk: string) => {
        for (const line of splitter.push(chunk)) this.handleLine(line, () => (sawResult = true));
      });
      group.child.stderr!.setEncoding("utf8");
      group.child.stderr!.on("data", (chunk: string) => {
        stderrTail.push(chunk);
        while (stderrTail.length > 20) stderrTail.shift();
      });

      const code = await group.exited;
      // A CLI that died mid-line still gets its last words parsed (crash-mid-line case).
      const tail = splitter.flush();
      if (tail) this.handleLine(tail, () => (sawResult = true));

      if (!sawResult && !this.interrupting && code !== 0) {
        const err = new Error(`claude exited ${code ?? "by signal"}: ${stderrTail.join("").trim().slice(-800)}`);
        this.failTurn(err);
      }
    } catch (e) {
      this.failTurn(e);
    } finally {
      this.group = undefined;
      this.askQuestionIds.clear();
      this.pendingOffers.clear();
      this.state = "idle"; // `error` is per-turn (failTurn already reported it); the runner stays usable
      if (this.queue.length > 0 && !this.closed) {
        void this.runNext();
      } else if (s.data.status !== "idle") {
        s.setStatus("idle");
      }
    }
  }

  /** One NDJSON line → parse → the same per-message pipeline the SDK driver ran. */
  private handleLine(line: string, markResult: () => void): void {
    const { msg, warn } = parseCCLine(line);
    if (warn) {
      console.warn(`[cc ${this.deps.session.id}] ${warn}`);
      return;
    }
    if (!msg) return;
    if (msg.type === "result") {
      markResult();
      this.state = "settling";
    }
    try {
      this.handleMessage(msg);
    } catch (e) {
      console.error(`[cc ${this.deps.session.id}] message handling failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private handleMessage(m: CCMessage): void {
    const s = this.deps.session;
    const sid = extractSessionId(m);
    if (sid) s.data.claudeSessionId = sid;

    // init reports the resolved slash-commands — publish for the composer's `/` autocomplete.
    if (this.deps.onCommands && m.type === "system" && (m as any).subtype === "init") {
      const slash = (m as any).slash_commands;
      if (Array.isArray(slash)) this.deps.onCommands(buildCommandInfo(slash, s.data.cwd));
    }

    // Context compaction boundary → persisted divider (ported from the SDK driver).
    if (m.type === "system" && (m as any).subtype === "compact_boundary") {
      const meta = (m as any).compact_metadata ?? {};
      const auto = meta.trigger === "auto";
      const pre = typeof meta.pre_tokens === "number" ? meta.pre_tokens : undefined;
      const post = typeof meta.post_tokens === "number" ? meta.post_tokens : undefined;
      const shrink = pre !== undefined && post !== undefined ? ` — ${fmtTokens(pre)} → ${fmtTokens(post)} tokens` : "";
      s.emit({
        type: "assistant.message",
        blocks: [
          {
            kind: "divider",
            label: auto ? "Context auto-compacted" : "Context compacted",
            note: `Older turns were summarized to free up the context window${shrink}. Claude keeps the summary; full history stays above for reference.`,
          },
        ],
      });
    }

    for (const id of askUserQuestionToolIds(m)) this.askQuestionIds.add(id);

    // Tool results are the goal judge's evidence (design D2).
    if (m.type === "user") {
      for (const b of ((m as any).message?.content ?? []) as any[]) {
        if (b?.type === "tool_result") {
          const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          s.recordTurnLine(`tool${b.is_error ? " ERROR" : ""}: ${body}`, GOAL_TRANSCRIPT_LINES);
        }
      }
    }
    // Stash the assistant's prose so a "your turn" push can quote it.
    if (m.type === "assistant") {
      const text = ((m as any).message?.content ?? [])
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text as string)
        .join(" ")
        .trim();
      if (text) s.lastAssistantText = text;
      if (text) s.recordTurnLine(`assistant: ${text}`, GOAL_TRANSCRIPT_LINES);
    }

    const bodies = mapMessage(m, this.deps.renderer);
    let sawToolUse = false;
    let sawToolResult = false;
    for (const body of bodies) {
      if (body.type === "tool.result" && this.askQuestionIds.delete(body.toolUseId)) continue;
      if (body.type === "tool.use") {
        sawToolUse = true;
        const p = deliverablePath(body.name, body.input);
        if (p) this.pendingOffers.set(body.toolUseId, p);
      }
      if (body.type === "tool.result") sawToolResult = true;
      s.emit(body);
      if (body.type === "tool.result" && this.pendingOffers.has(body.toolUseId)) {
        const path = this.pendingOffers.get(body.toolUseId)!;
        this.pendingOffers.delete(body.toolUseId);
        if (!body.isError) void this.offerFile(path);
      }
    }
    if (sawToolUse) s.setStatus("running_tool");
    if (sawToolResult) s.setStatus("thinking");

    if (m.type === "result") this.finishTurn(m);
  }

  /** TurnUsage from the result message alone (plan 3 task 6 — answered by the recordings):
   *  stream-json carries NO rate_limits/subscription (the gauge keeps its last-known value —
   *  the tracker treats null as "reading unavailable"), but usage + modelUsage are rich enough
   *  to DERIVE live context occupancy: the last request's input+cache tokens ARE the window
   *  content, and modelUsage reports the model's contextWindow. */
  private finishTurn(m: CCMessage): void {
    const s = this.deps.session;
    const usage = extractResultUsage(m);
    if (usage) {
      s.data.usage.inputTokens += usage.inputTokens;
      s.data.usage.outputTokens += usage.outputTokens;
      s.data.usage.turns += usage.turns;
    }
    const r = m as any;
    const costUsd = Number(r.total_cost_usd ?? 0);
    let contextUsage: { used: number; max: number } | null = null;
    const u = r.usage;
    const windows = Object.values(r.modelUsage ?? {}) as { contextWindow?: number }[];
    const max = windows.find((w) => typeof w.contextWindow === "number")?.contextWindow;
    if (u && typeof max === "number" && max > 0) {
      const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (used > 0) contextUsage = { used, max };
    }
    this.deps.onResult({ model: s.data.model, costUsd, rateLimits: null, subscriptionType: null, contextUsage });
    s.setStatus("idle");
  }

  private failTurn(e: unknown): void {
    const s = this.deps.session;
    this.state = "error";
    if (this.startedWithResume && isResumeRejectedError(e)) {
      // Same fallback as the SDK path (§5.3/Task 23): forget the rejected topic so the NEXT
      // prompt starts fresh instead of retrying the dead resume forever.
      s.data.claudeSessionId = undefined;
      s.data.context = undefined;
      s.emit({
        type: "assistant.message",
        blocks: [
          {
            kind: "divider",
            label: "Started a fresh context",
            note: "Couldn't resume the previous conversation — started a fresh context. Your worktree and files are untouched.",
          } satisfies ContentBlock,
        ],
      });
    } else {
      s.emitError(e instanceof Error ? e.message : String(e), false);
    }
    this.deps.onTurnError?.(e);
  }

  /** Realize a deliverable write into a download card (ported from the SDK driver). */
  private async offerFile(rawPath: string): Promise<void> {
    const s = this.deps.session;
    const offer = buildFileOffer(s.id, s.data.cwd, rawPath);
    if (!offer) return;
    try {
      offer.taildropped = await maybeTaildrop(offer.path);
    } catch {
      /* Taildrop is best-effort — the in-chat download card is the reliable path */
    }
    s.emit({ type: "file.offer", file: offer });
  }

  /**
   * The SDK path's system-prompt append, ported (tooling guidance + worktree pinning). The
   * concierge's MCP-tool briefing joins in Plan 5 when the daemon's HTTP MCP endpoint exists —
   * advertising tools the CLI can't reach would be worse than a plain concierge.
   */
  private systemPromptAppend(): string {
    const s = this.deps.session.data;
    let append =
      `TOOLING: Assume the command-line tools you need are already installed and discover them in the ` +
      `environment (check PATH with \`command -v\`/\`which\`, look at the project's package manifests / lockfiles, ` +
      `try the obvious invocation) before concluding a tool is missing. Do NOT stop to ask the user whether a ` +
      `common tool is available — just look. Only ask the user when a tool genuinely needs to be installed or ` +
      `downloaded first, or when it truly cannot be found after searching.`;
    if (s.source === "fresh-worktree") {
      const where = s.worktree ? ` (branch "${s.worktree.branch}", based on "${s.worktree.base}")` : "";
      append +=
        `\n\nWORKING DIRECTORY: You are operating inside an isolated git worktree at "${s.cwd}"${where}. ` +
        `This worktree is your ONLY workspace and already contains the full checkout. Always read, search, and edit files ` +
        `within this directory (use relative paths, or absolute paths under it). NEVER read from or write to the original ` +
        `repository checkout or any absolute path outside this worktree — even if you discover its location via ` +
        "`git worktree list`, git metadata, or documentation. All work for this task must stay in this worktree so it can be reviewed as a branch.";
    }
    return append;
  }
}
