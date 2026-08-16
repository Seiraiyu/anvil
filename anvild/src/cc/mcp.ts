/**
 * Adapter over `claude mcp …`.
 *
 * Writes (`add`/`remove`) are clean, supported, non-interactive. READS are the awkward half:
 * `claude mcp list` and `mcp get` have no `--json` (re-verified against 2.1.233), so §4.3 prefers
 * structured sources — `init.mcp_servers` from any turn, and the `mcpServers` field of
 * `claude plugin list --json` — and falls back to this tolerant parser only for user-added servers.
 */
import { defaultRun, resolveCcCommand, type CommandRunner } from "./install";

export interface McpServerInfo {
  name: string;
  target?: string;
  connected: boolean;
  /** True when the line could not be parsed — shown verbatim rather than dropped. */
  raw?: boolean;
}

export interface McpCliOpts {
  run?: CommandRunner;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

const SKIP = /^\s*$|^Checking MCP server health/i;

/** Lines look like `name: target - ✔ Connected`. Anything else is kept as a raw row. */
export function parseMcpList(out: string): McpServerInfo[] {
  const rows: McpServerInfo[] = [];
  for (const line of out.split("\n")) {
    if (SKIP.test(line)) continue;
    const text = line.trim();
    if (!text) continue;
    // The name is non-greedy up to the first `": "` — a URL's `https:` has no space after the
    // colon, so targets survive intact, as do `plugin:a:b`-style namespaced names.
    const m = /^(.+?):\s+(.*?)\s+-\s+(.*)$/.exec(text);
    if (!m) {
      rows.push({ name: text, connected: false, raw: true });
      continue;
    }
    rows.push({
      name: m[1]!.trim(),
      target: m[2]!.trim(),
      connected: /connected/i.test(m[3]!) && !/fail|error/i.test(m[3]!),
    });
  }
  return rows;
}

const SAFE_NAME = /^[A-Za-z0-9 ._:@/-]{1,120}$/;
const DEFAULT_TIMEOUT_MS = 60_000;

async function cc(args: string[], opts: McpCliOpts): Promise<string> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const cmd = [...resolveCcCommand(env), ...args];
  const { code, out } = await (opts.run ?? defaultRun)(cmd, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(opts.env ? { env: opts.env as Record<string, string> } : {}),
  });
  if (code !== 0) throw new Error(out || `claude ${args.join(" ")} exited ${code}`);
  return out;
}

export const listMcpServers = async (opts: McpCliOpts = {}): Promise<McpServerInfo[]> =>
  parseMcpList(await cc(["mcp", "list"], opts));

/** `add-json` takes the whole server config as one JSON argument — no shell-word splitting of
 *  commands, args, headers or env, which is what makes this safe to drive from a UI. */
export async function addMcpServer(
  name: string,
  config: Record<string, unknown>,
  opts: McpCliOpts = {},
): Promise<string> {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid mcp server name: ${name}`);
  return cc(["mcp", "add-json", name, JSON.stringify(config)], opts);
}

export async function removeMcpServer(name: string, opts: McpCliOpts = {}): Promise<string> {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid mcp server name: ${name}`);
  return cc(["mcp", "remove", name], opts);
}
