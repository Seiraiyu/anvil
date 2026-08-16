/**
 * Adapter over Claude Code's non-interactive plugin/marketplace CLI.
 *
 * Anvil never edits `~/.claude` directly: marketplace resolution, dependency pruning, cache layout
 * and version pinning stay the CLI's job (design §3.3). This module is the only place that knows
 * the command lines, and it exposes a CLOSED set of operations — there is deliberately no
 * "run any claude subcommand" escape hatch for a client to reach.
 */
import { defaultRun, resolveCcCommand, type CommandRunner } from "./install";

/** One installed plugin, normalised from `claude plugin list --json`. */
export interface PluginInfo {
  /** The CLI's own identifier, `name@marketplace` — pass this back verbatim to write commands. */
  id: string;
  name: string;
  marketplace: string;
  version: string;
  enabled: boolean;
  scope: string;
  installPath?: string;
  /** Servers this plugin brings with it (already structured in the CLI's JSON). */
  mcpServers: string[];
}

export interface PluginCliOpts {
  /** Injected in tests; defaults to the real Bun spawn runner. */
  run?: CommandRunner;
  /** Env for the child (tests point HOME at a temp dir). Defaults to the daemon's own env. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

/** Split `name@marketplace`; a bare id keeps its name and reports an empty marketplace. */
function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
}

/** Parse `claude plugin list --json`. Strict about the fields we use, tolerant of new ones. */
export function parsePluginList(raw: string): PluginInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`could not parse plugin list output as JSON: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(data)) throw new Error("plugin list output was not a JSON array");
  return data.map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = String(r.id ?? "");
    const { name, marketplace } = splitId(id);
    const servers = r.mcpServers && typeof r.mcpServers === "object" ? Object.keys(r.mcpServers as object) : [];
    return {
      id,
      name,
      marketplace,
      version: typeof r.version === "string" ? r.version : "unknown",
      enabled: r.enabled !== false,
      scope: typeof r.scope === "string" ? r.scope : "user",
      ...(typeof r.installPath === "string" ? { installPath: r.installPath } : {}),
      mcpServers: servers,
    };
  });
}

/**
 * Run one `claude …` subcommand and hand back its merged output.
 *
 * Shared by every command in this module so the binary-resolution precedence
 * (`ANVIL_CLI_PATH` → managed `current` → `claude` on PATH) is applied in exactly one place.
 * `out` is merged stdout+stderr, already trimmed — the CLI writes some notices to stderr, so a
 * non-zero exit's explanation is usually in there.
 */
export async function runCc(args: string[], opts: PluginCliOpts = {}): Promise<{ code: number; out: string }> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const run = opts.run ?? defaultRun;
  const cmd = [...resolveCcCommand(env), ...args];
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) filtered[k] = v;
  return run(cmd, { env: filtered, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
}
