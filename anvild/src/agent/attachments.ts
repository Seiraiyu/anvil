/**
 * User-message + attachment shaping for the CLI transport (arch §6.5). Formerly the non-queue half
 * of agent/input-queue.ts; the InputQueue itself died with the SDK driver (cc plan 7 task 6) — the
 * CLI transport queues prompts in the daemon (cc/turn-runner.ts) and writes ONE stream-json user
 * message per turn.
 */

/** The stream-json user message the CLI accepts on stdin (--input-format stream-json). */
export interface CcUserMessage {
  type: "user";
  message: { role: "user"; content: string | Record<string, unknown>[] };
  parent_tool_use_id: null;
  session_id: string;
}

export interface InlineAttachment {
  mediaType: string;
  name: string;
  data: string; // base64
}

/** Largest text file we inline into the prompt (bytes). Bigger files would blow the context. */
const MAX_INLINE_TEXT = 256 * 1024;

/** Heuristic: bytes are "text" if they decode as UTF-8 with no NUL bytes. */
function looksTextual(mediaType: string, buf: Buffer): boolean {
  if (mediaType.startsWith("text/")) return true;
  if (/^application\/(json|xml|x-yaml|yaml|javascript)/.test(mediaType)) return true;
  // Unknown/octet-stream: sniff for binary (a NUL byte in the first 8KB is a strong binary signal).
  return !buf.subarray(0, 8192).includes(0);
}

/**
 * Turn one uploaded attachment into an Anthropic content block: images → `image`, PDFs →
 * `document`, anything textual → an inline `text` block holding the file's contents (so the model
 * can actually read code/logs/configs), and a short note for binaries we can't inline. (arch §6.5)
 */
export function attachmentBlock(att: InlineAttachment): Record<string, unknown> {
  if (att.mediaType.startsWith("image/")) {
    return { type: "image", source: { type: "base64", media_type: att.mediaType, data: att.data } };
  }
  if (att.mediaType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: att.data } };
  }
  const buf = Buffer.from(att.data, "base64");
  if (looksTextual(att.mediaType, buf)) {
    const truncated = buf.length > MAX_INLINE_TEXT;
    const body = buf.subarray(0, MAX_INLINE_TEXT).toString("utf8");
    const note = truncated ? `\n…[truncated at ${MAX_INLINE_TEXT} bytes of ${buf.length}]` : "";
    return { type: "text", text: `Attached file "${att.name}":\n\n\`\`\`\n${body}${note}\n\`\`\`` };
  }
  return { type: "text", text: `[Attached file "${att.name}" (${att.mediaType}, ${buf.length} bytes) — binary, not inlined.]` };
}

/** Build a stream-json user message: text, plus any uploaded attachments as content blocks (arch §6.5). */
export function userMessage(text: string, attachments: InlineAttachment[] = []): CcUserMessage {
  const content =
    attachments.length === 0
      ? text
      : [...(text ? [{ type: "text", text }] : []), ...attachments.map(attachmentBlock)];
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  };
}
