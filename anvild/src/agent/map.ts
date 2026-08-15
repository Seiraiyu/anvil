import type { CCMessage } from "../cc/stream";
import type { ContentBlock, Usage } from "@protocol";
import type { SessionEventBody } from "../session/session";
import type { MarkdownRenderer } from "../render/markdown";

/** Handled via the question card (canUseTool), not the normal tool_use/tool.result path. */
const ASK_USER_QUESTION = "AskUserQuestion";

/** Assistant content-block types we deliberately render as NOTHING (thinking stays private;
 *  deltas already streamed). Anything else unrecognized becomes a fallback card — never dropped. */
const IGNORED_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

/** Max pretty-printed bytes a fallback card carries (design §4.7 delta 3 — size-capped). */
export const FALLBACK_JSON_CAP = 16 * 1024;

function fallbackBlock(ccType: string, raw: unknown): Extract<ContentBlock, { kind: "fallback" }> {
  let json: string;
  try {
    json = JSON.stringify(raw, null, 1) ?? String(raw);
  } catch {
    json = String(raw);
  }
  if (json.length > FALLBACK_JSON_CAP) json = `${json.slice(0, FALLBACK_JSON_CAP)}\n… [truncated]`;
  return { kind: "fallback", ccType, json };
}

/** The ids of any AskUserQuestion tool_use blocks in this message — so the driver can drop the
 *  matching tool.result (the answers echo), keeping all CC-shape knowledge in this module. */
export function askUserQuestionToolIds(m: CCMessage): string[] {
  if (m.type !== "assistant") return [];
  const content: any[] = (m as any).message?.content ?? [];
  return content.filter((b) => b?.type === "tool_use" && b.name === ASK_USER_QUESTION).map((b) => b.id as string);
}

/**
 * Pure translator: one `CCMessage` → the session-scoped events to emit (arch §6.2).
 * This is the CLI-drift containment point — keep all stream-json-shape knowledge here and
 * fixture-test it offline (test/unit/map.test.ts; shapes pinned by the golden recordings).
 */
export function mapMessage(m: CCMessage, renderer: MarkdownRenderer): SessionEventBody[] {
  return stampCcUuid(m, mapMessageBodies(m, renderer));
}

/** Correlate mapped events with the CC transcript line that produced them (cc plan 6): the
 *  stream-json line uuid EQUALS the on-disk transcript line uuid (pinned by the transcript
 *  golden), so the reconciler can dedupe backfills against live-logged events. Deltas stay
 *  unstamped (transient, never persisted); result events aren't transcript lines. */
function stampCcUuid(m: CCMessage, bodies: SessionEventBody[]): SessionEventBody[] {
  const uuid = (m as { uuid?: unknown }).uuid;
  if (typeof uuid !== "string" || uuid.length === 0) return bodies;
  for (const b of bodies) {
    if (b.type === "assistant.message" || b.type === "tool.use" || b.type === "tool.result") b.ccUuid = uuid;
  }
  return bodies;
}

function mapMessageBodies(m: CCMessage, renderer: MarkdownRenderer): SessionEventBody[] {
  switch (m.type) {
    case "stream_event": {
      const ev = (m as any).event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        return [{ type: "assistant.delta", text: ev.delta.text }];
      }
      return [];
    }

    case "assistant": {
      const content: any[] = (m as any).message?.content ?? [];
      const blocks: ContentBlock[] = [];
      const toolUses: SessionEventBody[] = [];
      for (const b of content) {
        if (b?.type === "text" && typeof b.text === "string") {
          blocks.push({ kind: "markdown", rendered: renderer.render(b.text) });
        } else if (b?.type === "tool_use") {
          // AskUserQuestion is rendered as an interactive question card (driven by the
          // question.request event), not as a tool block — suppress its raw tool_use here so
          // the transcript doesn't also dump the questions JSON. (arch §6.6)
          if (b.name === ASK_USER_QUESTION) continue;
          blocks.push({ kind: "tool_use", toolUseId: b.id, name: b.name, input: b.input });
          toolUses.push({ type: "tool.use", toolUseId: b.id, name: b.name, input: b.input });
        } else if (b && typeof b.type === "string" && !IGNORED_BLOCK_TYPES.has(b.type)) {
          // A content-block type this daemon doesn't know — surface it, never drop it (§4.7 delta 3).
          blocks.push(fallbackBlock(b.type, b));
        }
      }
      // Skip an assistant.message that held only an AskUserQuestion (now empty) so the client
      // doesn't render a blank bubble.
      const events: SessionEventBody[] = blocks.length ? [{ type: "assistant.message", blocks }] : [];
      return [...events, ...toolUses];
    }

    case "user": {
      const content = (m as any).message?.content;
      if (!Array.isArray(content)) return [];
      const out: SessionEventBody[] = [];
      for (const b of content) {
        if (b?.type === "tool_result") {
          out.push({
            type: "tool.result",
            toolUseId: b.tool_use_id,
            content: stringifyContent(b.content),
            isError: Boolean(b.is_error),
          });
        }
      }
      return out;
    }

    case "result": {
      const r = m as any;
      return [{ type: "result", stopReason: r.stop_reason ?? r.subtype ?? "end_turn", usage: resultUsage(r) }];
    }

    // An unknown TOP-LEVEL stream-json type, preserved by the parser (cc/stream.ts) — surface
    // it as a fallback card riding a normal assistant.message (§4.7 delta 3).
    case "unknown":
      return [{ type: "assistant.message", blocks: [fallbackBlock(m.ccType, m.raw)] }];

    default:
      return [];
  }
}

/** The CC session id (used as `claudeSessionId` for resume). */
export function extractSessionId(m: CCMessage): string | undefined {
  const sid = (m as any).session_id;
  return typeof sid === "string" && sid.length > 0 ? sid : undefined;
}

export function extractResultUsage(m: CCMessage): Usage | undefined {
  if (m.type !== "result") return undefined;
  return resultUsage(m as any);
}

function resultUsage(r: any): Usage {
  return {
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
    turns: r.num_turns ?? 1,
  };
}

function stringifyContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b?.text === "string" ? b.text : JSON.stringify(b))).join("");
  return c == null ? "" : JSON.stringify(c);
}
