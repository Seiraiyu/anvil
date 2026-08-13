import { GOAL_MAX_ITERATIONS, type SessionGoal } from "@protocol";
import { runCcMicroQuery, type CcMicroQueryOpts } from "../cc/oneshot";

export { GOAL_MAX_ITERATIONS };

/** How many buffered transcript lines the judge sees (~5 turns of assistant text + tool results). */
export const GOAL_TRANSCRIPT_LINES = 40;

export type GoalCommand =
  | { kind: "set"; condition: string }
  | { kind: "clear" }
  | { kind: "status" };

/**
 * Parse a `/goal` message. Like `/clear` and `/compact`, the command must be the WHOLE message —
 * anything else is ordinary prose and must reach the model untouched.
 */
export function parseGoalCommand(text: string): GoalCommand | undefined {
  const t = text.trim();
  if (t === "/goal") return { kind: "status" };
  if (!t.startsWith("/goal ")) return undefined;
  const rest = t.slice("/goal ".length).trim();
  if (!rest) return { kind: "status" };
  if (rest.toLowerCase() === "clear") return { kind: "clear" };
  return { kind: "set", condition: rest };
}

export interface GoalVerdict {
  met: boolean;
  reason: string;
}

/**
 * Parse the judge's reply. Deliberately strict: anything unrecognised THROWS so the hook's
 * fail-open path (design D6) treats a confused judge exactly like an unreachable one — a goal must
 * never trap a session on the strength of a garbled answer.
 */
export function parseVerdict(text: string): GoalVerdict {
  const t = text.trim();
  if (/^met\b/i.test(t)) return { met: true, reason: "" };
  const m = /^unmet\s*:?\s*(.*)$/is.exec(t);
  if (m) return { met: false, reason: (m[1] ?? "").trim() || "condition not yet satisfied" };
  throw new Error(`unparseable goal verdict: ${t.slice(0, 120)}`);
}

/**
 * Judge whether `condition` is satisfied by the recent transcript. One-shot Haiku, no tools
 * (CLI-direct micro-query) — mirrors `classifyBranchKind`. Throws on timeout, transport failure,
 * or an unparseable reply; every one of those is fail-open at the call site (D6).
 */
export async function judgeGoal(
  condition: string,
  transcript: string,
  env: Record<string, string>,
  cc?: Pick<CcMicroQueryOpts, "ccCommand" | "extraEnv">,
): Promise<GoalVerdict> {
  const prompt =
    `You are judging whether a coding agent has satisfied a stated goal.\n\n` +
    `GOAL: ${condition}\n\n` +
    `Recent transcript (most recent last):\n"""\n${transcript.slice(-8000)}\n"""\n\n` +
    `Judge ONLY on evidence in the transcript — tool results, command output, errors. A claim by ` +
    `the agent that it succeeded is NOT evidence if the tool result contradicts it or is absent.\n\n` +
    `Reply with EXACTLY one line:\n` +
    `MET\n` +
    `or\n` +
    `UNMET: <short reason, max 15 words>`;

  const text = await runCcMicroQuery(prompt, { model: "haiku", env, timeoutMs: 20_000, ...cc });
  return parseVerdict(text);
}

// The Stop-hook LOGIC (no-goal free path, ceiling, D6 fail-open, `{decision:"block", reason}` —
// the spike-verified blocking contract, design §10 R1) lives in the supervisor's `ccStopHook`,
// reached over HTTP from the per-session CC settings overlay (cc/mcp-config.ts). The SDK-callback
// `makeStopHook` died with the driver (cc plan 7). Do NOT switch the block reply to
// `hookSpecificOutput.additionalContext` — that arrives as a system reminder the model refuses as
// a suspected prompt injection, yielding a session that loops without doing the work.
