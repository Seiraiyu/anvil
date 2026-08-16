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
 * Run one `claude …` subcommand, returning trimmed merged output. Throws on nonzero exit.
 *
 * Shared by every command in this module so the binary-resolution precedence
 * (`ANVIL_CLI_PATH` → managed `current` → `claude` on PATH) is applied in exactly one place.
 * `out` is merged stdout+stderr — the CLI writes notices to stderr, so a failure's explanation is
 * usually in there, and passing it through beats inventing a message (design §7).
 */
async function cc(args: string[], opts: PluginCliOpts): Promise<string> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const runner = opts.run ?? defaultRun;
  const cmd = [...resolveCcCommand(env), ...args];
  const { code, out } = await runner(cmd, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(opts.env ? { env: opts.env as Record<string, string> } : {}),
  });
  if (code !== 0) throw new Error(out || `claude ${args.join(" ")} exited ${code}`);
  return out;
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────
// Flags verified against claude 2.1.233: `plugin list` takes `--json` and `--available`
// (which itself REQUIRES --json, so both are always passed together).

export const listPlugins = async (opts: PluginCliOpts = {}): Promise<PluginInfo[]> =>
  parsePluginList(await cc(["plugin", "list", "--json"], opts));

export const listAvailablePlugins = async (opts: PluginCliOpts = {}): Promise<PluginInfo[]> =>
  parsePluginList(await cc(["plugin", "list", "--available", "--json"], opts));

// ── writes ──────────────────────────────────────────────────────────────────────────────────────

/** The closed set of plugin mutations Anvil exposes. Anything else is refused. */
export type PluginOp = "install" | "uninstall" | "enable" | "disable" | "update";
const PLUGIN_OPS: readonly PluginOp[] = ["install", "uninstall", "enable", "disable", "update"];

/** Plugin ids are `name@marketplace` — letters, digits and a small punctuation set. We REJECT
 *  anything else rather than trying to escape it: there is no legitimate id with a shell
 *  metacharacter, and rejecting keeps this impossible to turn into command injection. */
const SAFE_ID = /^[A-Za-z0-9._@/-]{1,200}$/;

export interface PluginOpOpts extends PluginCliOpts {
  /** `user` (default), `project` or `local` — the CLI's own scopes. */
  scope?: string;
}

export async function pluginOp(op: PluginOp, id: string, opts: PluginOpOpts = {}): Promise<string> {
  if (!PLUGIN_OPS.includes(op)) throw new Error(`unsupported plugin operation: ${op}`);
  if (!SAFE_ID.test(id)) throw new Error(`invalid plugin id: ${id}`);
  const args = ["plugin", op, id];
  // `-y` is REQUIRED for a marketplace-declared install command when stdin/stdout is not a TTY,
  // which is always true for us. Only install prompts, so only install gets it.
  if (op === "install") {
    args.push("--yes");
    if (opts.scope) args.push("--scope", opts.scope);
  }
  return cc(args, opts);
}

// ── marketplaces ────────────────────────────────────────────────────────────────────────────────

export type MarketplaceOp = "add" | "remove" | "update";
const MARKETPLACE_OPS: readonly MarketplaceOp[] = ["add", "remove", "update"];
/** A marketplace source is a URL, a path, or `owner/repo` — same reject-don't-escape rule as ids. */
const SAFE_SOURCE = /^[A-Za-z0-9._:@/~-]{1,400}$/;

/** Marketplaces are listed as raw JSON text; callers hand it straight to the client. */
export const listMarketplaces = async (opts: PluginCliOpts = {}): Promise<unknown> => {
  const raw = await cc(["plugin", "marketplace", "list", "--json"], opts);
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
};

export async function marketplaceOp(op: MarketplaceOp, source: string, opts: PluginCliOpts = {}): Promise<string> {
  if (!MARKETPLACE_OPS.includes(op)) throw new Error(`unsupported marketplace operation: ${op}`);
  if (!SAFE_SOURCE.test(source)) throw new Error(`invalid marketplace source: ${source}`);
  return cc(["plugin", "marketplace", op, source], opts);
}
