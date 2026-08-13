/**
 * Vendored Claude Code on-disk transcript shapes + reader (cc plan 6, design §4.9).
 * `~/.claude/projects/<slug>/<sessionId>.jsonl` is the authoritative record of a CC
 * session ("disk is truth"); these line shapes are a DIFFERENT format from the stream-json
 * stdout shapes (cc/stream.ts) and are pinned by their own golden fixture
 * (test/fixtures/cc-transcript/, recorded by test/tools/record-cc-transcript.ts).
 *
 * What the recordings pin (2026-08-13, cc 2.1.231):
 *   - user/assistant lines carry a `uuid` that EQUALS the `uuid` on the corresponding
 *     stream-json stdout line — the reconciler's dedupe key (plan 6 fixed decision).
 *   - `--resume <id>` (headless AND interactive TUI) APPENDS to the same transcript file;
 *     the session id is stable across resumes.
 *   - TUI-driven sessions interleave non-message line types (mode, queue-operation,
 *     file-history-snapshot, ai-title, last-prompt, attachment, summary, system, …) that a
 *     reader must skip without assuming any shape beyond `type`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A conversation message line — the only lines the reconciler projects into the event log. */
export interface TranscriptMessageLine {
  type: "user" | "assistant";
  uuid: string;
  parentUuid?: string | null;
  /** CLI-internal messages (caveats, local-command echoes) — never conversation content. */
  isMeta?: boolean;
  /** Sub-agent (Task tool) traffic; modern CC keeps it in sibling agent-*.jsonl files, but skip defensively. */
  isSidechain?: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  /** Anthropic API message shape — the same content-block layout the stream-json stdout carries,
   *  so message lines feed the SAME mapper (agent/map.ts) as live turns. */
  message: { role?: string; content?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

/** Any other line type (mode, queue-operation, file-history-snapshot, summary, system, …). */
export interface TranscriptOtherLine {
  type: string;
  uuid?: string;
  [k: string]: unknown;
}

export type TranscriptLine = TranscriptMessageLine | TranscriptOtherLine;

/** Message lines are the reconciler's input; everything else is transport/UI bookkeeping. */
export function isMessageLine(l: TranscriptLine): l is TranscriptMessageLine {
  return (
    (l.type === "user" || l.type === "assistant") &&
    typeof (l as { uuid?: unknown }).uuid === "string" &&
    typeof (l as { message?: unknown }).message === "object" &&
    (l as { message?: unknown }).message !== null
  );
}

export interface ParsedTranscriptLine {
  line?: TranscriptLine;
  /** Human-readable reason a line was skipped — logged, never a crash (mirrors cc/stream.ts). */
  warn?: string;
}

export function parseTranscriptLine(raw: string): ParsedTranscriptLine {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    return { warn: `unparseable transcript line: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { warn: "non-object transcript line; skipped" };
  const rec = obj as Record<string, unknown>;
  if (typeof rec.type !== "string") return { warn: "transcript line without string `type`; skipped" };
  return { line: rec as TranscriptLine };
}

/** Read a whole transcript, tolerant of a torn final line (a crashed CC dies mid-write). */
export function readTranscript(path: string): { lines: TranscriptLine[]; warns: string[] } {
  const lines: TranscriptLine[] = [];
  const warns: string[] = [];
  if (!existsSync(path)) return { lines, warns };
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const { line, warn } = parseTranscriptLine(raw);
    if (warn) warns.push(warn);
    if (line) lines.push(line);
  }
  return { lines, warns };
}

/**
 * CC's project-directory slug for a cwd: every non-alphanumeric character becomes "-"
 * (case preserved). Derived the same way CC does and VERIFIED against the recorded fixture
 * (the recorder locates the real transcript by session id and asserts the directory name
 * matches this derivation — plan 6 fixed decision: do not hand-roll from assumption).
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The CC config root: `$CLAUDE_CONFIG_DIR` when set, else `~/.claude` (same rule as the CLI). */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

/** Absolute path of the transcript for one CC session run in `cwd`. */
export function transcriptPath(cwd: string, claudeSessionId: string, configDir: string = claudeConfigDir()): string {
  return join(configDir, "projects", projectSlug(cwd), `${claudeSessionId}.jsonl`);
}
