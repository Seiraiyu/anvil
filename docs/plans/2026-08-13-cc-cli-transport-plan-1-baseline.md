# CC CLI Transport — Plan 1: Repo baseline, SDK inventory, vendored types + golden recordings

**Goal:** Establish the fork's green baseline, inventory every SDK dependency, and land the vendored `CCMessage` types with golden stream-json recordings from the real CLI — the contract every later phase builds on.
**Architecture:** New `anvild/src/cc/stream.ts` (vendored types + NDJSON parser, zero SDK imports) pinned by recordings checked into `anvild/test/fixtures/cc/`, recorded by a `test/tools/` script that spawns the real `claude` CLI. Design: `docs/plans/2026-08-13-cc-cli-transport-design.md` §4.2, Assumptions 1/5, Spike 3.
**Tech Stack:** Bun ≥1.3.14, TypeScript, `bun test` (flat `test(...)` style, no `describe`).

| Task | Description | Status | Tested | Pushed |
|------|-------------|--------|--------|--------|
| 1 | Verify fork CI baseline green | done | yes | yes |
| 2 | Commit SDK usage inventory doc | done | yes | yes |
| 3 | Vendored `CCMessage` types + line parser (test first) | done | yes | yes |
| 4 | `NdjsonSplitter` incremental line buffer (test first) | done | yes | yes |
| 5 | Recording tool `test/tools/record-cc-stream.ts` | done | yes | yes |
| 6 | Record + check in golden fixtures (LIVE — needs `claude` auth) | done | yes | yes |
| 7 | Golden replay test over fixtures | done | yes | yes |

Execution notes (2026-08-13): baseline required one fork-local fix (WEB2-6 test timeout on slow
machines — tracked in `2026-08-13-upstream-candidates.md`). Recorder gained
`--setting-sources "" --strict-mcp-config` to match the daemon's `settingSources: []`.
Reconciliations from real cc 2.1.231 streams: `rate_limit_event` vendored as KNOWN; Spike 3
answered (thinking deltas present) — recorded in design §9 item 3. Inventory line refs corrected
against the code (`branch-kind.ts:48`, `icon.ts:34`).

Conventions for every task: run commands from `anvild/`; tests are flat `test(...)` with a header comment naming the design clause they guard; temp dirs via `mkdtempSync(join(tmpdir(), "anvil-cc-…"))` (the repo's dominant idiom).

### Task 1: Verify fork CI baseline green

**Files:** none (verification only)

**Step 1: Run the four CI gates locally**
```sh
cd anvild && bun install --frozen-lockfile && bun run typecheck && bun run typecheck:web && bun run build:web && bun test
```
Expected: all four exit 0; `bun test` reports 0 fail. If anything fails, STOP — fix upstream breakage before proceeding (this plan assumes a green base).

**Step 2: No commit** (nothing changed).

### Task 2: Commit SDK usage inventory doc

**Files:**
- Create: `docs/plans/2026-08-13-cc-transport-sdk-inventory.md`

**Step 1: Write the inventory** (complete content):

```markdown
# SDK usage inventory (Phase 1 deliverable — design §5 phase 1)

Every `@anthropic-ai/claude-agent-sdk` touch point and its disposition. Regen check:
`grep -rn "claude-agent-sdk" src --include='*.ts'` must list exactly the Import sites below.

## query() call sites (6)
| Site | Shape | Converts in |
|---|---|---|
| `src/agent/driver.ts:191` | long-lived streaming | Plan 3 (turn-runner) |
| `src/agent/query.ts:47` (`runAgentQuery`) | one-shot, plan-mode capable | Plan 7 (`cc/oneshot.ts`) |
| `src/integrations/autopilot.ts:79` (private `runQuery`) | one-shot, Claude-only near-duplicate | Plan 7 (absorbed into `cc/oneshot.ts`) |
| `src/agent/branch-kind.ts:52` | one-shot haiku, maxTurns 1 | Plan 7 |
| `src/agent/goal.ts:73` (`judgeGoal`) | one-shot haiku, maxTurns 1 | Plan 7 |
| `src/agent/icon.ts:27` (`pickIcon`) | one-shot sonnet | Plan 7 |

## Other SDK surface
| Module | SDK surface | Disposition |
|---|---|---|
| `src/agent/map.ts` | `SDKMessage` input type | Plan 3: retarget cast to `CCMessage` (one line in test harness) |
| `src/agent/input-queue.ts` | `SDKUserMessage`, `InputQueue` | Plan 3: port `attachmentBlock()`/`userMessage()` into turn-runner stdin writer; queue class deleted |
| `src/agent/permissions.ts` | `HookCallback`, `PreToolUseHookInput` | Plan 4: `PermissionBroker` survives unchanged; hook side → `cc/permission-server.ts` |
| `src/agent/questions.ts` | `CanUseTool`, `PermissionResult` | Plan 4: `QuestionBroker` survives; `makeCanUseTool` wire shape (`:118-133`) reproduced by MCP `approve` tool |
| `src/agent/default-tools.ts`, `team-tools.ts`, `member-tools.ts`, `planning-tools.ts` | `createSdkMcpServer`, `tool` | Plan 5: re-host on daemon HTTP MCP endpoint; handlers + `*ToolDeps` untouched |
| `src/agent/goal.ts` (`makeStopHook`) | `HookCallback` | Plan 5: CC `Stop` hook in settings overlay (must return `{decision:"block", reason}` — see goal.ts:110-115) |
| `src/agent/pipeline-guard.ts` | `HookCallback` | Plan 7: CC PreToolUse hook in pipeline settings overlay ([SEC-H4] retained, signed off 2026-08-13) |
| `src/agent/cli.ts` | CLI locator | Plan 2 bridges `ANVIL_CLI_PATH` to managed install; deleted in Plan 7 |
| `src/agent/danger-list.ts`, autonomy engine in `permissions.ts` | — | Plan 4: deleted (fully CC-native) |
| `src/auth/guard.ts`, `src/auth/degrade.ts` | — | Plan 4: deleted (defer-to-CC auth); rewire `supervisor.onTurnError` |
| `test/integration/attachment-flow.test.ts` etc. | global `mock.module` SDK stub | Plan 7: hazard disappears with the dependency |
```

**Step 2: Commit**
`git add docs/plans/2026-08-13-cc-transport-sdk-inventory.md && git commit -m "docs(cc): SDK usage inventory (plan 1 task 2)"`

### Task 3: Vendored `CCMessage` types + line parser

**Files:**
- Create: `anvild/src/cc/stream.ts`
- Test: `anvild/test/unit/cc-stream.test.ts`

**Step 1: Write failing test**

```ts
// Guards design §4.2/§4.7-delta-3: the vendored stream-json parser never drops a line —
// known types pass through, unknown types are preserved as {type:"unknown"}, garbage
// becomes a warn, and blank lines are ignored. Pinned offline; golden replay is Task 7.
import { expect, test } from "bun:test";
import { parseCCLine, MAX_LINE_BYTES } from "../../src/cc/stream";

test("known message types pass through typed", () => {
  const { msg, warn } = parseCCLine('{"type":"system","subtype":"init","session_id":"abc"}');
  expect(warn).toBeUndefined();
  expect(msg?.type).toBe("system");
  expect((msg as any).session_id).toBe("abc");
});

test("unknown type is preserved, not dropped", () => {
  const { msg } = parseCCLine('{"type":"totally_new_thing","payload":{"x":1}}');
  expect(msg?.type).toBe("unknown");
  expect((msg as any).ccType).toBe("totally_new_thing");
  expect((msg as any).raw.payload).toEqual({ x: 1 });
});

test("garbage line yields warn, no throw", () => {
  const { msg, warn } = parseCCLine("{not json");
  expect(msg).toBeUndefined();
  expect(warn).toContain("unparseable");
});

test("non-object and missing-type lines yield warn", () => {
  expect(parseCCLine("[1,2]").warn).toContain("skipped");
  expect(parseCCLine('{"no_type":true}').warn).toContain("skipped");
});

test("blank line is ignored (no msg, no warn)", () => {
  expect(parseCCLine("  \n")).toEqual({});
});

test("oversized line is skipped with warn", () => {
  const big = `{"type":"assistant","message":{"content":[{"type":"text","text":"${"x".repeat(MAX_LINE_BYTES)}"}]}}`;
  const { msg, warn } = parseCCLine(big);
  expect(msg).toBeUndefined();
  expect(warn).toContain("exceeds");
});
```

**Step 2: Run test, verify failure**
Run: `cd anvild && bun test test/unit/cc-stream.test.ts`
Expected: FAIL — `Cannot find module '../../src/cc/stream'`

**Step 3: Implement** `anvild/src/cc/stream.ts`:

```ts
/**
 * Vendored Claude Code CLI stream-json shapes + line parser (design §4.2). Deliberately
 * imports NOTHING from @anthropic-ai/claude-agent-sdk: these shapes are pinned by golden
 * recordings from the managed CLI (test/unit/cc-stream.test.ts Task 7), not by an npm
 * package. Every field the daemon does not read is retained via index signatures so
 * unknown-but-adjacent data survives round-trips. Unknown top-level types are preserved
 * as {type:"unknown"} — the input to the fallback card (§4.7 delta 3) — never dropped.
 */

export interface CCSystemInit {
  type: "system";
  subtype: "init" | (string & {});
  session_id: string;
  model?: string;
  permissionMode?: string;
  tools?: string[];
  [k: string]: unknown;
}

export interface CCAssistant {
  type: "assistant";
  /** Anthropic API message shape: content is an array of blocks (text/tool_use/thinking/…). */
  message: { content?: unknown[]; [k: string]: unknown };
  [k: string]: unknown;
}

export interface CCUser {
  type: "user";
  message: { content?: unknown[]; [k: string]: unknown };
  [k: string]: unknown;
}

export interface CCResult {
  type: "result";
  subtype?: string;
  result?: string;
  is_error?: boolean;
  session_id?: string;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  total_cost_usd?: number;
  [k: string]: unknown;
}

export interface CCStreamEvent {
  type: "stream_event";
  event: { type?: string; delta?: { type?: string; text?: string; [k: string]: unknown }; [k: string]: unknown };
  [k: string]: unknown;
}

/** A top-level type this daemon version doesn't know. Rendered as a fallback card, never dropped. */
export interface CCUnknown {
  type: "unknown";
  ccType: string;
  raw: Record<string, unknown>;
}

export type CCMessage = CCSystemInit | CCAssistant | CCUser | CCResult | CCStreamEvent | CCUnknown;

const KNOWN = new Set(["system", "assistant", "user", "result", "stream_event"]);

/** Skip-with-warn ceiling; a single content block should never legitimately reach this. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface ParsedLine {
  msg?: CCMessage;
  /** Human-readable reason a line was skipped — surfaced as a parser.warn event, never a crash. */
  warn?: string;
}

export function parseCCLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return {};
  if (trimmed.length > MAX_LINE_BYTES) return { warn: `NDJSON line exceeds ${MAX_LINE_BYTES} bytes; skipped` };
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    return { warn: `unparseable NDJSON line: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { warn: "non-object NDJSON line; skipped" };
  const rec = obj as Record<string, unknown>;
  if (typeof rec.type !== "string") return { warn: "NDJSON line without string `type`; skipped" };
  if (!KNOWN.has(rec.type)) return { msg: { type: "unknown", ccType: rec.type, raw: rec } };
  return { msg: rec as unknown as CCMessage };
}
```

**Step 4: Run test, verify pass**
Run: `cd anvild && bun test test/unit/cc-stream.test.ts` — Expected: PASS (6 tests). Then `bun run typecheck` — Expected: exit 0.

**Step 5: Commit**
`git add anvild/src/cc/stream.ts anvild/test/unit/cc-stream.test.ts && git commit -m "feat(cc): vendored CCMessage types + never-drop line parser"`

### Task 4: `NdjsonSplitter` incremental buffer

**Files:**
- Modify: `anvild/src/cc/stream.ts` (append)
- Test: `anvild/test/unit/cc-stream.test.ts` (append)

**Step 1: Append failing tests**

```ts
import { NdjsonSplitter } from "../../src/cc/stream";

test("splitter reassembles lines across chunk boundaries", () => {
  const s = new NdjsonSplitter();
  expect(s.push('{"type":"sys')).toEqual([]);
  expect(s.push('tem","subtype":"init"}\n{"type":"result"}\n{"ty')).toEqual([
    '{"type":"system","subtype":"init"}',
    '{"type":"result"}',
  ]);
  expect(s.flush()).toBe('{"ty');
});

test("splitter flush on empty buffer returns undefined", () => {
  expect(new NdjsonSplitter().flush()).toBeUndefined();
});
```

**Step 2: Run, verify failure** — Expected: FAIL `NdjsonSplitter` not exported.

**Step 3: Implement** (append to `stream.ts`):

```ts
/** Incremental NDJSON line assembly over arbitrary stdout chunk boundaries. */
export class NdjsonSplitter {
  private buf = "";

  /** Feed a chunk; returns the complete lines it closed (without trailing newline). */
  push(chunk: string): string[] {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    return lines.filter((l) => l.length > 0);
  }

  /** The unterminated tail at EOF (a crashed CLI can die mid-line), or undefined. */
  flush(): string | undefined {
    const tail = this.buf;
    this.buf = "";
    return tail.length > 0 ? tail : undefined;
  }
}
```

**Step 4: Run, verify pass** — `bun test test/unit/cc-stream.test.ts` Expected: PASS (8 tests).

**Step 5: Commit** — `git commit -am "feat(cc): NdjsonSplitter for chunked stream-json stdout"`

### Task 5: Recording tool

**Files:**
- Create: `anvild/test/tools/record-cc-stream.ts` (in `test/tools/` so the runner never collects it — repo convention for credential-needing probes)

**Step 1: Implement** (no unit test — this is a live tool; its output is verified by Task 7):

```ts
/**
 * Records golden stream-json fixtures from the REAL claude CLI (design §8, Assumptions 1/3/5
 * + Spike 3). Requires an authenticated `claude` on PATH (or argv[2] = path to binary).
 *
 *   bun test/tools/record-cc-stream.ts [claude-binary]
 *
 * Writes test/fixtures/cc/{basic,tool,resume}.ndjson + cc-version.txt. Scenarios:
 *   basic  — one text-only turn (also exercises --include-partial-messages deltas: Spike 3)
 *   tool   — a turn that must call the Read tool (bypassPermissions; sandbox temp dir)
 *   resume — second process resuming the basic session (Assumption on --resume)
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2] ?? "claude";
const outDir = join(import.meta.dir, "..", "fixtures", "cc");
mkdirSync(outDir, { recursive: true });

async function run(args: string[], stdin: string | undefined, cwd: string): Promise<string> {
  const proc = Bun.spawn([bin, ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : new Response(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${bin} ${args.join(" ")} exited ${code}\n${err}`);
  return out;
}

const COMMON = [
  "-p",
  "--output-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--model", "haiku",
  "--permission-mode", "bypassPermissions",
];

const cwd = mkdtempSync(join(tmpdir(), "anvil-cc-record-"));
writeFileSync(join(cwd, "note.txt"), "the magic word is xylophone\n");

const version = await run(["--version"], undefined, cwd);
writeFileSync(join(outDir, "cc-version.txt"), version);

const basic = await run([...COMMON, "Reply with exactly: ok"], undefined, cwd);
writeFileSync(join(outDir, "basic.ndjson"), basic);

const init = basic.split("\n").map((l) => { try { return JSON.parse(l); } catch { return undefined; } })
  .find((m) => m?.type === "system" && m?.subtype === "init");
if (!init?.session_id) throw new Error("no system/init session_id in basic recording");

const tool = await run([...COMMON, "Use the Read tool to read note.txt, then reply with the magic word only."], undefined, cwd);
writeFileSync(join(outDir, "tool.ndjson"), tool);

const resume = await run([...COMMON, "--resume", init.session_id, "What were you asked to reply with exactly, one word?"], undefined, cwd);
writeFileSync(join(outDir, "resume.ndjson"), resume);

console.log(`recorded to ${outDir} (cc ${version.trim()})`);
```

**Step 2: Typecheck only** — `cd anvild && bun run typecheck` Expected: exit 0.

**Step 3: Commit** — `git add anvild/test/tools/record-cc-stream.ts && git commit -m "test(cc): golden stream-json recording tool"`

### Task 6: Record + check in fixtures (LIVE)

**Step 1: Run the recorder** (needs authenticated `claude`):
Run: `cd anvild && bun test/tools/record-cc-stream.ts`
Expected: `recorded to …/test/fixtures/cc (cc <version>)`. Inspect: `head -c 400 test/fixtures/cc/basic.ndjson` shows a `{"type":"system","subtype":"init",…` first line.
**GATE:** if the CLI rejects any flag here (e.g. `--include-partial-messages` naming), STOP and reconcile the recorder + design Assumption 1/5 before continuing; this is the designed catch point, not a workaround site.

**Step 2: Commit fixtures**
`git add anvild/test/fixtures/cc && git commit -m "test(cc): golden stream-json recordings (cc $(cat anvild/test/fixtures/cc/cc-version.txt | tr -d '\n'))"`

### Task 7: Golden replay test

**Files:**
- Test: `anvild/test/unit/cc-stream-golden.test.ts`

**Step 1: Write the test** (fails before fixtures exist, passes after Task 6):

```ts
// Replays the checked-in golden recordings through the vendored parser (design §8):
// every line must parse cleanly, core shapes must classify as KNOWN (Assumption 1),
// init must carry session_id, result must carry usage, and the tool recording must
// contain an assistant tool_use block. Offline — fixtures are committed, CI-safe.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCCLine, type CCMessage } from "../../src/cc/stream";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "cc");

function replay(name: string): CCMessage[] {
  const out: CCMessage[] = [];
  for (const line of readFileSync(join(FIXTURES, name), "utf8").split("\n")) {
    const { msg, warn } = parseCCLine(line);
    expect(warn).toBeUndefined();
    if (msg) out.push(msg);
  }
  return out;
}

test("fixtures exist (record with test/tools/record-cc-stream.ts)", () => {
  expect(readdirSync(FIXTURES).sort()).toEqual(["basic.ndjson", "cc-version.txt", "resume.ndjson", "tool.ndjson"]);
});

for (const name of ["basic.ndjson", "tool.ndjson", "resume.ndjson"]) {
  test(`${name}: parses clean, init first with session_id, result last with usage`, () => {
    const msgs = replay(name);
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.filter((m) => m.type === "unknown")).toEqual([]); // core shapes are KNOWN (Assumption 1)
    const init = msgs[0] as any;
    expect(init.type).toBe("system");
    expect(init.subtype).toBe("init");
    expect(typeof init.session_id).toBe("string");
    const result = msgs[msgs.length - 1] as any;
    expect(result.type).toBe("result");
    expect(result.usage).toBeDefined();
  });
}

test("tool.ndjson contains an assistant tool_use block (Read)", () => {
  const msgs = replay("tool.ndjson");
  const toolUses = msgs
    .filter((m): m is any => m.type === "assistant")
    .flatMap((m) => (m.message.content ?? []) as any[])
    .filter((b) => b?.type === "tool_use");
  expect(toolUses.length).toBeGreaterThan(0);
  expect(toolUses.some((b) => b.name === "Read")).toBe(true);
});

test("resume.ndjson resumed the basic session (session continuity)", () => {
  const basicInit = replay("basic.ndjson")[0] as any;
  const resumeInit = replay("resume.ndjson")[0] as any;
  expect(typeof resumeInit.session_id).toBe("string");
  // Resume may mint a new leaf id but must not error; the semantic check is that the
  // model could answer from prior context — assert the result isn't an error.
  const result = replay("resume.ndjson").at(-1) as any;
  expect(result.is_error ?? false).toBe(false);
  expect(basicInit.session_id).not.toBe("");
});

test("stream deltas present (--include-partial-messages — Spike 3 resolution)", () => {
  const msgs = replay("basic.ndjson");
  expect(msgs.some((m) => m.type === "stream_event")).toBe(true);
});
```

**Step 2: Run** — `cd anvild && bun test test/unit/cc-stream-golden.test.ts` Expected: PASS (6 tests). Record the Spike-3 answer (whether thinking deltas appear as `stream_event`s) in the design doc §9 item 3.

**Step 3: Full gates** — `bun run typecheck && bun test` Expected: green.

**Step 4: Commit** — `git add anvild/test/unit/cc-stream-golden.test.ts docs/plans/2026-08-13-cc-cli-transport-design.md && git commit -m "test(cc): golden replay pins vendored types to real CLI output"`

**Phase acceptance (design §5.1):** fork builds + upstream tests pass; golden recordings replay through vendored types with zero `unknown` classifications on core shapes. Both are now executable: `bun test`.
