/**
 * LIVE spike (cc-config design §6.5 / D-5..D-7): do CC's `auto` permission mode and Anvil's
 * approval card COMPOSE? The design's human-checkpoint recipe claims `permissions.ask` rules are
 * evaluated BEFORE the classifier and always prompt — and that those prompts are engine-originated,
 * so they arrive at `--permission-prompt-tool mcp__anvild__approve` and become a `permission.request`
 * card on every device. Everything downstream of the approve tool (broker → card → push) is already
 * exercised by probe-cc-permission.ts; the open question was only whether `auto` mode routes there
 * at all, or whether its classifier swallows the decision and denies silently.
 *
 *   bun test/tools/probe-auto-ask.ts
 *
 * Hosts the same minimal streamable-HTTP MCP `approve` server as probe-cc-permission.ts, builds a
 * real git repo with a LOCAL BARE REMOTE (so the push is genuine and needs no network), then drives:
 *   D0) CONTROL: `git --version` under auto with the rule loaded → must NOT reach approve
 *       (the classifier auto-allows it; the checkpoint must be surgical, not a blanket prompt).
 *   D1) `git push` under auto with `permissions.ask: ["Bash(git push *)"]` → approve MUST be invoked
 *       with tool_name=Bash and a `git push` command. This is the load-bearing assertion.
 *   D2) answered {behavior:"deny"} → the push must NOT reach the remote (remote stays empty).
 *   D3) answered {behavior:"allow"} → the push lands (remote HEAD moves).
 *
 * ── FINDINGS (verified live 2026-08-16, claude 2.1.233 — ALL PASS) ──
 * (a) CONFIRMED — `permissions.ask` IS evaluated under `auto` and takes precedence over the
 *     classifier: a `git push` matching `Bash(git push *)` arrives at `mcp__anvild__approve` as a
 *     normal engine-originated prompt, bearer header intact. Auto mode and Anvil's approval card
 *     compose; D-5..D-7 rest on solid ground.
 * (b) CONFIRMED — the card's answer is authoritative in both directions: {behavior:"deny"} left the
 *     bare remote at 0 commits and surfaced the deny message to the model; {behavior:"allow"} let the
 *     push land (remote → 1 commit). Not a simulated prompt — a real push over a real remote.
 * (c) CONFIRMED — the checkpoint is surgical: with the ask rule loaded, an auto-allowed command
 *     (`echo`) still reaches approve ZERO times. Adding an ask rule does not broaden prompting.
 * (-) CAUTION for whoever writes the next control: `git --version` reaches the approve tool in
 *     `default` mode too, with NO ask rule, with and without user settings. It is outside CC's
 *     built-in safe list once a prompt tool is configured — nothing to do with auto mode. An earlier
 *     draft of D0 used it and "failed" while the product was fine. Pick a command CC actually
 *     auto-allows, or the control measures the allow-list's breadth, not the checkpoint's precision.
 *
 * Uses `--setting-sources ""` so the developer's real ~/.claude never participates, and injects the
 * ask rule via `--settings` inline JSON instead. NOTHING here writes to the real ~/.claude.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BEARER = "auto-ask-probe-12345";
const calls: { tool: string; input: any; headersOk: boolean }[] = [];
let mode: "allow" | "deny" = "allow";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method !== "POST") return new Response("ok", { status: 200 });
    const headersOk = req.headers.get("authorization") === `Bearer ${BEARER}`;
    const body = (await req.json()) as { id?: number | string; method: string; params?: any };
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    switch (body.method) {
      case "initialize":
        return reply({
          protocolVersion: body.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "anvild", version: "0.0.0-probe" },
        });
      case "tools/list":
        return reply({
          tools: [
            {
              name: "approve",
              description: "Anvil permission gate: routes CLI permission prompts to the daemon.",
              inputSchema: {
                type: "object",
                properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
                additionalProperties: true,
              },
            },
          ],
        });
      case "tools/call": {
        const args = body.params?.arguments ?? {};
        calls.push({ tool: String(args.tool_name), input: args.input, headersOk });
        console.log(
          `\x1b[36m[approve]\x1b[0m tool=${args.tool_name} headersOk=${headersOk} input=${JSON.stringify(args.input).slice(0, 160)}`,
        );
        const result =
          mode === "deny"
            ? { behavior: "deny", message: "denied by probe (human tapped Deny on the card)" }
            : { behavior: "allow", updatedInput: args.input };
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
      }
      default:
        return body.id === undefined ? new Response(null, { status: 202 }) : reply({});
    }
  },
});

// ── a real repo with a real (local, bare) remote ────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "anvil-auto-ask-"));
const cwd = join(root, "work");
const remote = join(root, "remote.git");
const sh = async (cmdCwd: string, ...cmd: string[]) => {
  const p = Bun.spawn(cmd, { cwd: cmdCwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed in ${cmdCwd}`);
  return out.trim();
};
await sh(root, "git", "init", "--bare", "-b", "main", remote);
await sh(root, "git", "init", "-b", "main", cwd);
await sh(cwd, "git", "config", "user.email", "probe@example.com");
await sh(cwd, "git", "config", "user.name", "Probe");
writeFileSync(join(cwd, "seed.txt"), "seed\n");
await sh(cwd, "git", "add", "-A");
await sh(cwd, "git", "commit", "-q", "-m", "seed");
await sh(cwd, "git", "remote", "add", "origin", remote);

/** Commits on the bare remote's main — 0 until a push actually lands. */
const remoteCommits = async (): Promise<number> => {
  const p = Bun.spawn(["git", "rev-list", "--count", "main"], { cwd: remote, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? Number(out.trim() || 0) : 0;
};

const mcpConfig = join(root, "mcp.json");
writeFileSync(
  mcpConfig,
  JSON.stringify({
    mcpServers: {
      anvild: { type: "http", url: `http://127.0.0.1:${server.port}`, headers: { Authorization: `Bearer ${BEARER}` } },
    },
  }),
);

// The design's recipe, verbatim: one ask rule, everything else unattended.
const SETTINGS = JSON.stringify({ permissions: { ask: ["Bash(git push *)"] } });

/**
 * `isolated` mirrors a hermetic test box (`--setting-sources ""`); `user` mirrors how anvild ACTUALLY
 * spawns — the CLI transport deliberately dropped `settingSources: []`, so a real session reads the
 * user's `~/.claude`. The distinction is not cosmetic: the auto-mode classifier's own config
 * (`autoMode.allow` / `$defaults` …) lives in user settings, so an isolated spawn has no classifier
 * config to consult and falls back to prompting for far more than a configured box would. Both are
 * read-only — nothing here ever writes to the real ~/.claude.
 */
async function turn(prompt: string, sources: "isolated" | "user" = "isolated"): Promise<string> {
  const proc = Bun.spawn(
    [
      "claude", "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--model", "haiku",
      "--permission-mode", "auto", // the D-6 default under test
      ...(sources === "isolated" ? ["--setting-sources", ""] : []),
      "--settings", SETTINGS, // the ask rule, injected either way
      "--strict-mcp-config",
      "--mcp-config", mcpConfig,
      "--permission-prompt-tool", "mcp__anvild__approve",
    ],
    { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) console.error(`turn exited ${code}: ${err.slice(-400)}`);
  return out;
}

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name} — ${detail}`);
};

// A command CC's engine auto-allows on its own. Do NOT use `git --version` here: measured live, it
// reaches the approve tool in `default` mode too, with no ask rule loaded and with or without user
// settings — i.e. it is simply outside CC's built-in safe list once a prompt tool is configured, not
// evidence of anything about auto mode. The control has to be a command that is genuinely auto-allowed,
// or it measures the allow-list's breadth instead of the checkpoint's precision.
const CONTROL = "Using the Bash tool, run exactly: echo probe-ctl-42 . Then report the output.";

console.log("── D0 CONTROL: an auto-allowed command must NOT reach approve even with the ask rule loaded ──");
mode = "allow";
let before = calls.length;
await turn(CONTROL, "user");
check(
  "D0 the ask rule does not broaden prompting (user settings, as anvild spawns)",
  calls.length === before,
  `approve calls: ${calls.length - before} (want 0 — the checkpoint must be surgical)`,
);

console.log("── D1/D2: `git push` under auto, human taps DENY ──");
mode = "deny";
before = calls.length;
const d2 = await turn("Using the Bash tool, run exactly: git push origin main . Then report what happened.");
const pushCalls = calls.slice(before).filter((c) => c.tool === "Bash" && /git\s+push/.test(JSON.stringify(c.input)));
check(
  "D1 permissions.ask routes to the approve tool under auto",
  pushCalls.length > 0,
  `approve invocations for a git push: ${pushCalls.length} (want ≥1 — this is the load-bearing claim)`,
);
check("D1b bearer header arrives", calls.slice(before).every((c) => c.headersOk), "Authorization pass-through");
const afterDeny = await remoteCommits();
check(
  "D2 deny blocks the push",
  afterDeny === 0,
  `remote commits after deny: ${afterDeny} (want 0); model saw deny msg: ${d2.includes("denied by probe")}`,
);

console.log("── D3: same push, human taps ALLOW ──");
mode = "allow";
before = calls.length;
await turn("Using the Bash tool, run exactly: git push origin main . Then report what happened.");
const afterAllow = await remoteCommits();
check(
  "D3 allow lets the push land",
  afterAllow > 0,
  `remote commits after allow: ${afterAllow} (want ≥1); approve calls: ${calls.length - before}`,
);

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? "\x1b[32mALL PASS\x1b[0m" : `\x1b[31m${failed.length} FAILED\x1b[0m`} — repo: ${root}`);
server.stop(true);
process.exit(failed.length === 0 ? 0 : 1);
