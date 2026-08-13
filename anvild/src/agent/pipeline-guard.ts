import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";

/**
 * [SEC-H4] The safety backstop for the UNATTENDED dev pipeline (agent/query.ts) — retained
 * through the cc plan 4 permission overhaul (signed off 2026-08-13). Interactive sessions now
 * defer to CC's own permission engine with a human answering prompts; the pipeline has no human
 * in the loop and drives a third-party model (GLM) with Write/Edit/Bash enabled, so the only
 * safe default is to DENY anything this table flags and allow the rest. The table below is the
 * old repo-wide danger list, now scoped to (and owned by) this guard.
 *
 * `cwd` is the run's worktree; passed through so writes escaping it are treated as dangerous.
 */
interface DangerVerdict {
  danger: boolean;
  reason?: string;
}

const BASH_PATTERNS: [RegExp, string][] = [
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, "recursive force remove (rm -rf)"],
  [/\bgit\s+push\b[^\n]*(--force(?!-with-lease)|\s-f\b)/i, "git force-push"],
  [/\bgit\s+reset\s+--hard\b/i, "git reset --hard"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "git clean -f"],
  [/\b(drop\s+database|drop\s+table|truncate\s+table|delete\s+from)\b/i, "destructive SQL"],
  [/\b(npm|pnpm|yarn)\s+publish\b/i, "package publish"],
  [/\b(sudo|doas)\b/i, "privilege escalation"],
  [/:\s*\(\s*\)\s*\{[^}]*\}\s*;/, "fork bomb"],
  [/\bmkfs\b|\bdd\s+if=[^\n]*of=\/dev\//i, "raw disk write"],
  [/\bcurl\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, "pipe-to-shell from network"],
];

const SECRET_PATH = /(^|\/)\.env(\.[a-z]+)?$|\/\.ssh\/|id_(rsa|ed25519)|(^|\/)credentials\b|\.pem$|\.p8$|\bsecrets?\b/i;

function isDangerous(toolName: string, input: Record<string, unknown>, cwd?: string): DangerVerdict {
  const command = typeof input.command === "string" ? input.command : "";

  if (toolName === "Bash" && command) {
    for (const [re, reason] of BASH_PATTERNS) {
      if (re.test(command)) return { danger: true, reason };
    }
  }

  // credential / secret paths across any tool that names a path
  const pathish = [input.file_path, input.path, input.notebook_path, command]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" ");
  if (SECRET_PATH.test(pathish)) return { danger: true, reason: "credential/secret path" };

  // writes resolving outside the session worktree
  if (cwd && (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit")) {
    const fp = input.file_path ?? input.notebook_path;
    if (typeof fp === "string" && fp.startsWith("/") && !resolve(fp).startsWith(resolve(cwd))) {
      return { danger: true, reason: "write outside the session worktree" };
    }
  }

  return { danger: false };
}

export interface GuardVerdict {
  behavior: "allow" | "deny";
  reason: string;
}

export function pipelineGuardVerdict(
  tool: string,
  input: Record<string, unknown>,
  cwd?: string,
): GuardVerdict {
  const verdict = isDangerous(tool, input, cwd);
  if (verdict.danger) {
    return { behavior: "deny", reason: verdict.reason ?? "flagged by danger list" };
  }
  return { behavior: "allow", reason: "non-dangerous (pipeline auto-allow)" };
}

/** PreToolUse hook that hard-denies dangerous tools in an unattended pipeline run. */
export function makePipelineGuardHook(cwd?: string): HookCallback {
  return async (input) => {
    const i = input as PreToolUseHookInput;
    const tool = i.tool_name;
    const toolInput = (i.tool_input ?? {}) as Record<string, unknown>;

    // AskUserQuestion has no answer path in an unattended run; let it fall through so the SDK's
    // default handling applies rather than a fabricated decision (mirrors the interactive gate).
    if (tool === "AskUserQuestion") return { continue: true };

    const { behavior, reason } = pipelineGuardVerdict(tool, toolInput, cwd);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: behavior,
        permissionDecisionReason:
          behavior === "deny" ? `pipeline denied — ${reason}` : reason,
      },
    };
  };
}
