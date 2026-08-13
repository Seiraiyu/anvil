/**
 * Per-session MCP wiring for the CLI-direct transport (plan 4 task 3, design §4.4): each
 * session gets a `.mcp.json` pointing the CLI at the daemon's own MCP endpoint
 * (`/api/cc/mcp/<sessionId>`) with a per-session bearer. The bearer is the only thing
 * standing between "any tailnet process" and "can answer this session's permission prompts",
 * so it's minted per session, never persisted anywhere but the config file itself, and
 * rotated on session reset (a stale config on disk then fails closed with a 401).
 */
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CC_MCP_SERVER_NAME = "anvild";
/** The tool id the CLI is told to use for permission prompts (`--permission-prompt-tool`). */
export const CC_PERMISSION_TOOL = `mcp__${CC_MCP_SERVER_NAME}__approve`;

export interface CcMcpConfigOpts {
  stateDir: string;
  /** The daemon's BOUND host — the CLI connects back over it. Wildcard/absent ⇒ loopback. */
  host?: string;
  port: number;
}

export class CcMcpConfig {
  private readonly tokens = new Map<string, string>();
  private readonly dir: string;

  constructor(private readonly opts: CcMcpConfigOpts) {
    this.dir = join(opts.stateDir, "cc-mcp");
    mkdirSync(this.dir, { recursive: true });
  }

  tokenFor(sessionId: string): string {
    let t = this.tokens.get(sessionId);
    if (!t) {
      t = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      this.tokens.set(sessionId, t);
    }
    return t;
  }

  /** New bearer (session reset / kill): the next writeConfig hands the CLI the fresh one. */
  rotate(sessionId: string): void {
    this.tokens.delete(sessionId);
  }

  /** Constant-time check of an incoming Authorization header for this session. */
  verify(sessionId: string, authHeader: string | null | undefined): boolean {
    const t = this.tokens.get(sessionId);
    if (!t || !authHeader?.startsWith("Bearer ")) return false;
    const got = Buffer.from(authHeader.slice("Bearer ".length));
    const want = Buffer.from(t);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private baseUrl(): string {
    const host = !this.opts.host || this.opts.host === "0.0.0.0" || this.opts.host === "::" ? "127.0.0.1" : this.opts.host;
    return `http://${host}:${this.opts.port}`;
  }

  /**
   * Write (or refresh) the session's .mcp.json; returns its path for `--mcp-config`.
   * `toolServers` (plan 5 task 2) adds the session's role tool servers — the old 4-way
   * AgentDriver ternary, expressed as entries: each server rides the SAME bearer at
   * /api/cc/mcp/<sessionId>/<serverName>.
   */
  writeConfig(sessionId: string, toolServers: string[] = []): string {
    const auth = { Authorization: `Bearer ${this.tokenFor(sessionId)}` };
    const base = `${this.baseUrl()}/api/cc/mcp/${sessionId}`;
    const servers: Record<string, unknown> = {
      [CC_MCP_SERVER_NAME]: { type: "http", url: base, headers: auth },
    };
    for (const name of toolServers) servers[name] = { type: "http", url: `${base}/${name}`, headers: auth };
    const path = join(this.dir, `${sessionId}.mcp.json`);
    writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2));
    return path;
  }

  /**
   * Per-session `--settings` overlay (plan 5 task 3, design §4.3): contains ONLY additive anvil
   * feature hooks — user/project settings load normally and are never overridden. Hook commands
   * are small curl calls back into the daemon carrying the session bearer; CC pipes the hook's
   * stdin JSON through and honors the daemon's JSON reply on stdout. Undefined when no anvil
   * hooks apply (most sessions) so the spawn skips the flag entirely.
   */
  writeSettingsOverlay(sessionId: string, opts: { goalStopHook: boolean }): string | undefined {
    if (!opts.goalStopHook) return undefined;
    const url = `${this.baseUrl()}/api/cc/hook/${sessionId}/stop`;
    const command =
      `curl -sf -m 90 -X POST ` +
      `-H 'Authorization: Bearer ${this.tokenFor(sessionId)}' ` +
      `-H 'content-type: application/json' --data-binary @- '${url}'`;
    const overlay = {
      hooks: {
        // The goal judge (agent/goal.ts semantics): unmet ⇒ {"decision":"block","reason"} on
        // stdout. 120s hook timeout covers the judge's own abort with headroom.
        Stop: [{ hooks: [{ type: "command", command, timeout: 120 }] }],
      },
    };
    const path = join(this.dir, `${sessionId}.settings.json`);
    writeFileSync(path, JSON.stringify(overlay, null, 2));
    return path;
  }
}
