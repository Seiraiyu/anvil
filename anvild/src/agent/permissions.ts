import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionDecision, PermissionSuggestion } from "@protocol";
import { newId } from "../util/ids";
import type { Session } from "../session/session";

interface ResolvedDecision {
  decision: PermissionDecision;
  updatedInput?: Record<string, unknown>;
}
interface Pending {
  resolve: (d: ResolvedDecision) => void;
  sessionId: string;
}

/**
 * Holds permission prompts blocked in the PreToolUse hook until a client answers (arch §6.6).
 * Keyed by `requestId`; resolved by `permission.respond` — possibly from another device.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();

  request(requestId: string, sessionId: string): Promise<ResolvedDecision> {
    return new Promise((resolve) => this.pending.set(requestId, { resolve, sessionId }));
  }
  sessionFor(requestId: string): string | undefined {
    return this.pending.get(requestId)?.sessionId;
  }
  resolve(requestId: string, decision: PermissionDecision, updatedInput?: unknown): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.resolve({ decision, updatedInput: updatedInput as Record<string, unknown> | undefined });
    return true;
  }

  /** Resolve every prompt parked for a session (used by session.reset to unblock a wedged hook). */
  resolveSession(sessionId: string, decision: PermissionDecision): number {
    let n = 0;
    for (const [requestId, p] of this.pending) {
      if (p.sessionId === sessionId) {
        this.pending.delete(requestId);
        p.resolve({ decision });
        n++;
      }
    }
    return n;
  }
}

export const SUGGESTIONS = (tool: string): PermissionSuggestion[] => [
  { decision: "allow", label: "Allow once" },
  { decision: "allow_always", label: `Always allow ${tool} this session` },
  { decision: "deny", label: "Deny" },
];

/**
 * Called when the model asks to leave plan mode (ExitPlanMode) with its finished plan. Lets the
 * daemon run the adversarial panel over the plan before it's approved (advisory only — see the
 * supervisor's planReviewer). Awaited so the critique lands before execution; must never throw.
 */
export type PlanProposedHook = (plan: string) => Promise<void>;

/**
 * PreToolUse hook for the (legacy, until Plan 8) SDK transport — CC-NATIVE since cc plan 4:
 * the old autonomy-policy engine and its danger table are gone. The CLI's own permission engine decides
 * what prompts; prompt-worthy calls surface through `canUseTool` (agent/questions.ts) → the
 * brokers → every device. This hook only:
 *   - runs the advisory adversarial plan review when the model calls ExitPlanMode;
 *   - lets everything fall through with a bare `continue` so the engine's verdict stands.
 */
export function makePreToolUseHook(
  session: Session,
  _broker: PermissionBroker,
  onPlanProposed?: PlanProposedHook,
): HookCallback {
  return async (input) => {
    const i = input as PreToolUseHookInput;
    if (i.tool_name === "ExitPlanMode" && onPlanProposed) {
      const toolInput = (i.tool_input ?? {}) as Record<string, unknown>;
      try {
        await onPlanProposed(typeof toolInput.plan === "string" ? toolInput.plan : "");
      } catch {
        /* advisory only — a panel failure must never block the plan */
      }
    }
    void session;
    return { continue: true };
  };
}

export type AskPermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/**
 * Park one prompt-worthy tool call for a human (arch §6.6) — the shared core of BOTH transports:
 * the CLI path's MCP approve tool (cc/permission-server.ts) and the SDK path's canUseTool
 * (agent/questions.ts). Fans the permission.request card to every device and holds indefinitely
 * (pocket-phone is the product); session.reset force-resolves wedged prompts.
 */
export async function askPermission(
  session: Session,
  broker: PermissionBroker,
  toolName: string,
  input: Record<string, unknown>,
): Promise<AskPermissionResult> {
  // A remembered "always allow" answers the re-ask inside the daemon — no card, no round trip.
  if (session.isAlwaysAllowed(toolName)) return { behavior: "allow", updatedInput: input };

  const requestId = newId("perm");
  const answer = broker.request(requestId, session.id);
  session.requestPermission(requestId, toolName, input, SUGGESTIONS(toolName));
  const ans = await answer;

  if (ans.decision === "deny") return { behavior: "deny", message: "denied by user" };
  if (ans.decision === "allow_always") session.rememberAllow(toolName);
  return { behavior: "allow", updatedInput: (ans.updatedInput as Record<string, unknown>) ?? input };
}
