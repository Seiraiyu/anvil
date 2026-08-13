/**
 * Transcript reconciler (cc plan 6, design §4.9): "disk is truth". CC's on-disk transcript
 * (`~/.claude/projects/<slug>/<id>.jsonl`) is the authoritative record of a session; the
 * daemon's event log is a projection that can fall behind it (daemon crash mid-turn, turns
 * taken in an attached real terminal). Reconcile = diff the transcript against the event log
 * and backfill what's missing, through the SAME mapper + renderer the live stream uses, with
 * fresh `seq` (clients already handle catch-up replay by seq — no client change).
 *
 * Dedupe (design §7 "must never double-apply"):
 *   - assistant / tool-result lines: by transcript-line `uuid` against the `ccUuid` the live
 *     CLI transport stamps on mapped events (stream uuid == transcript uuid, pinned by the
 *     transcript golden fixture).
 *   - user PROMPT lines: the daemon logs `message.user` BEFORE the turn spawns, so those
 *     events can't carry a ccUuid — matched by prompt text instead (order-insensitive
 *     multiset of un-correlated message.user sources). Unmatched user lines are PTY-attach
 *     turns (or lines lost with a crashed daemon's un-flushed log) and get backfilled WITH
 *     their ccUuid, so a second reconcile skips them by uuid.
 *
 * Idempotent by construction: every backfilled event carries its transcript uuid, so
 * re-running against the same transcript is a no-op.
 */
import type { ServerEvent } from "@protocol";
import { mapMessage } from "../agent/map";
import type { CCMessage } from "./stream";
import type { MarkdownRenderer } from "../render/markdown";
import type { SessionEventBody } from "../session/session";
import { isMessageLine, readTranscript, type TranscriptMessageLine } from "./transcript";

export interface ReconcileDeps {
  renderer: MarkdownRenderer;
  /** The session's persisted events, in log order (EventLog.since(0)). */
  events: () => ServerEvent[];
  /** Emit one backfilled event (Session.emit): mints fresh seq, appends, broadcasts. */
  emit: (body: SessionEventBody) => void;
}

export interface ReconcileOutcome {
  /** Events emitted into the log by this run. */
  backfilled: number;
  /** Conversation message lines the transcript held (after CLI-internal filtering). */
  scanned: number;
  warns: string[];
}

/** CLI-internal user-line content that must never be projected as a conversation message:
 *  slash-command echoes/output (NOT reliably isMeta — pinned by the golden fixture), the
 *  interrupt marker, and compaction bookkeeping. */
const CLI_INTERNAL_TEXT = /^\s*(<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)|\[Request interrupted)/;

/** The text of a user PROMPT line: string content as-is, else its first text block (a daemon
 *  prompt with attachments appends attachment blocks after the text — the first block is the
 *  prompt the daemon logged). Undefined ⇒ not a prompt (tool results, pure-attachment lines). */
function promptText(l: TranscriptMessageLine): string | undefined {
  const c = l.message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const t = c.find((b) => (b as { type?: string })?.type === "text") as { text?: unknown } | undefined;
    return typeof t?.text === "string" ? t.text : undefined;
  }
  return undefined;
}

function isToolResultLine(l: TranscriptMessageLine): boolean {
  const c = l.message.content;
  return Array.isArray(c) && c.some((b) => (b as { type?: string })?.type === "tool_result");
}

/** Diff one transcript file against the event log; backfill the gap. Missing file ⇒ no-op. */
export function reconcileTranscript(transcriptFile: string, deps: ReconcileDeps): ReconcileOutcome {
  const { lines, warns } = readTranscript(transcriptFile);
  const msgs = lines.filter(isMessageLine).filter((l) => !l.isMeta && !l.isSidechain && l.isCompactSummary !== true);

  // What the log already holds: uuid-correlated events, plus the raw texts of the daemon's own
  // (un-correlated) message.user events for prompt matching.
  const known = new Set<string>();
  const daemonPrompts = new Map<string, number>();
  let uncorrelatedContent = false;
  for (const e of deps.events()) {
    const ccUuid = (e as { ccUuid?: unknown }).ccUuid;
    if (typeof ccUuid === "string") {
      known.add(ccUuid);
    } else if (e.type === "message.user") {
      const source = (e as { rendered?: { source?: unknown } }).rendered?.source;
      if (typeof source === "string") daemonPrompts.set(source, (daemonPrompts.get(source) ?? 0) + 1);
    } else if (e.type === "assistant.message" || e.type === "tool.use" || e.type === "tool.result") {
      uncorrelatedContent = true;
    }
  }

  // Legacy guard: a log that holds assistant/tool history with ZERO ccUuid correlation predates
  // plan 6's stamping — assistant lines can't be deduped, so a reconcile would duplicate the whole
  // conversation. Skip; the session becomes heal-able after its next live turn stamps events.
  if (known.size === 0 && uncorrelatedContent) {
    return {
      backfilled: 0,
      scanned: 0,
      warns: [...warns, "event log holds assistant history without ccUuid correlation (pre-plan-6); reconcile skipped to avoid duplication"],
    };
  }

  let backfilled = 0;
  let scanned = 0;
  const emitAll = (bodies: SessionEventBody[]) => {
    for (const b of bodies) {
      deps.emit(b);
      backfilled++;
    }
  };

  for (const l of msgs) {
    if (l.type === "user" && !isToolResultLine(l)) {
      const text = promptText(l);
      if (text === undefined || text.trim() === "" || CLI_INTERNAL_TEXT.test(text)) continue;
      scanned++;
      if (known.has(l.uuid)) continue;
      const logged = daemonPrompts.get(text) ?? 0;
      if (logged > 0) {
        daemonPrompts.set(text, logged - 1); // the daemon already logged this prompt at prompt.send
        continue;
      }
      emitAll([{ type: "message.user", rendered: deps.renderer.render(text), attachments: [], ccUuid: l.uuid }]);
      continue;
    }
    scanned++;
    if (known.has(l.uuid)) continue;
    // Assistant lines and tool-result user lines are shaped exactly like their stream-json
    // twins — same mapper, same renderer as a live turn (mapMessage stamps ccUuid from the
    // line's own uuid). Thinking-only assistant lines map to nothing, correctly.
    emitAll(mapMessage(l as unknown as CCMessage, deps.renderer));
  }

  return { backfilled, scanned, warns };
}
