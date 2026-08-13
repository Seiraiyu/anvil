/**
 * Vendored Claude Code CLI stream-json shapes + line parser (design §4.2). Deliberately
 * imports NOTHING from @anthropic-ai/claude-agent-sdk: these shapes are pinned by golden
 * recordings from the managed CLI (test/unit/cc-stream.test.ts Task 7), not by an npm
 * package. Every field the daemon does not read is retained via index signatures so
 * unknown-but-adjacent data survives round-trips. Unknown top-level types are preserved
 * as {type:"unknown"} — the input to the fallback card (§4.7 delta 3) — never dropped.
 */

export interface CCSystemInit {
  type: "system";
  subtype: "init" | (string & {});
  session_id: string;
  model?: string;
  permissionMode?: string;
  tools?: string[];
  [k: string]: unknown;
}

export interface CCAssistant {
  type: "assistant";
  /** Anthropic API message shape: content is an array of blocks (text/tool_use/thinking/…). */
  message: { content?: unknown[]; [k: string]: unknown };
  [k: string]: unknown;
}

export interface CCUser {
  type: "user";
  message: { content?: unknown[]; [k: string]: unknown };
  [k: string]: unknown;
}

export interface CCResult {
  type: "result";
  subtype?: string;
  result?: string;
  is_error?: boolean;
  session_id?: string;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  total_cost_usd?: number;
  [k: string]: unknown;
}

export interface CCStreamEvent {
  type: "stream_event";
  event: { type?: string; delta?: { type?: string; text?: string; [k: string]: unknown }; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * Rate-limit telemetry the CLI emits alongside every turn (observed in cc 2.1.231 golden
 * recordings — one per API request). Vendored as KNOWN because it appears in every stream;
 * feeds the account usage display eventually, ignorable until then.
 */
export interface CCRateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info?: Record<string, unknown>;
  [k: string]: unknown;
}

/** A top-level type this daemon version doesn't know. Rendered as a fallback card, never dropped. */
export interface CCUnknown {
  type: "unknown";
  ccType: string;
  raw: Record<string, unknown>;
}

export type CCMessage = CCSystemInit | CCAssistant | CCUser | CCResult | CCStreamEvent | CCRateLimitEvent | CCUnknown;

const KNOWN = new Set(["system", "assistant", "user", "result", "stream_event", "rate_limit_event"]);

/** Skip-with-warn ceiling; a single content block should never legitimately reach this. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface ParsedLine {
  msg?: CCMessage;
  /** Human-readable reason a line was skipped — surfaced as a parser.warn event, never a crash. */
  warn?: string;
}

export function parseCCLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return {};
  if (trimmed.length > MAX_LINE_BYTES) return { warn: `NDJSON line exceeds ${MAX_LINE_BYTES} bytes; skipped` };
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    return { warn: `unparseable NDJSON line: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { warn: "non-object NDJSON line; skipped" };
  const rec = obj as Record<string, unknown>;
  if (typeof rec.type !== "string") return { warn: "NDJSON line without string `type`; skipped" };
  if (!KNOWN.has(rec.type)) return { msg: { type: "unknown", ccType: rec.type, raw: rec } };
  return { msg: rec as unknown as CCMessage };
}

/** Incremental NDJSON line assembly over arbitrary stdout chunk boundaries. */
export class NdjsonSplitter {
  private buf = "";

  /** Feed a chunk; returns the complete lines it closed (without trailing newline). */
  push(chunk: string): string[] {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    return lines.filter((l) => l.length > 0);
  }

  /** The unterminated tail at EOF (a crashed CLI can die mid-line), or undefined. */
  flush(): string | undefined {
    const tail = this.buf;
    this.buf = "";
    return tail.length > 0 ? tail : undefined;
  }
}
