import type { Question, QuestionAnswer } from "@protocol";

/**
 * AskUserQuestion plumbing (arch §6.6).
 *
 * Claude's AskUserQuestion tool does NOT come back as a normal tool result: its `checkPermissions`
 * always resolves to "ask", so it surfaces through the permission channel — since cc plan 4 that is
 * the daemon's MCP approve tool (cc/permission-server.ts), which recognises the tool name, parks
 * the question here, renders the existing question card on every device, and returns the chosen
 * answers as `updatedInput`. The CLI re-runs the tool with that input and its result builder emits
 * "Your questions have been answered: …". The wire shape (confirmed live): `{ behavior: "allow",
 * updatedInput: { ...originalInput, answers: { [questionText]: label | label[] }, annotations? } }`.
 * The `answers` map MUST be keyed by the exact question text (the CLI looks up `answers[question]`
 * per original question); a multiSelect answer may be an array (the CLI joins it) or a comma-joined
 * string.
 */

interface QuestionResolution {
  cancelled: boolean;
  answers?: QuestionAnswer[];
}
interface Pending {
  resolve: (r: QuestionResolution) => void;
  sessionId: string;
}

/** Holds AskUserQuestion prompts parked in `canUseTool` until a client answers them. */
export class QuestionBroker {
  private readonly pending = new Map<string, Pending>();

  request(requestId: string, sessionId: string): Promise<QuestionResolution> {
    return new Promise((resolve) => this.pending.set(requestId, { resolve, sessionId }));
  }
  sessionFor(requestId: string): string | undefined {
    return this.pending.get(requestId)?.sessionId;
  }
  resolve(requestId: string, resolution: QuestionResolution): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.resolve(resolution);
    return true;
  }
  /** Cancel every question parked for a session (used by session.reset to unblock the dialog). */
  resolveSession(sessionId: string): number {
    let n = 0;
    for (const [requestId, p] of this.pending) {
      if (p.sessionId === sessionId) {
        this.pending.delete(requestId);
        p.resolve({ cancelled: true });
        n++;
      }
    }
    return n;
  }
}

/** Coerce the SDK's opaque dialog payload `questions` into our typed shape (defensive). */
export function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== "string") continue;
    const options = Array.isArray(r.options)
      ? r.options
          .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
          .map((o) => ({
            label: typeof o.label === "string" ? o.label : String(o.label ?? ""),
            description: typeof o.description === "string" ? o.description : "",
            ...(typeof o.preview === "string" ? { preview: o.preview } : {}),
          }))
      : [];
    out.push({
      question: r.question,
      header: typeof r.header === "string" ? r.header : "",
      options,
      ...(typeof r.multiSelect === "boolean" ? { multiSelect: r.multiSelect } : {}),
    });
  }
  return out;
}

