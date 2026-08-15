/**
 * LIVE spike (plan 4 task 1, design Assumption 3): does the CLI's `--permission-prompt-tool`
 * contract carry anvild's whole remote-permission UX in `-p` mode?
 *
 *   bun test/tools/probe-cc-permission.ts
 *
 * Hosts a minimal streamable-HTTP MCP server with one `approve` tool, writes an .mcp.json
 * pointing at it (with an Authorization header, to prove header pass-through), then drives
 * three real turns:
 *   A) a Bash call in default mode  → expect `approve` invoked; {behavior:"allow",
 *      updatedInput} lets the command run (its output must reach the transcript);
 *   B) same call answered {behavior:"deny"}  → tool must NOT run;
 *   C) AskUserQuestion → does the ask arrive via `approve` too? Answer with the
 *      questions.ts:118-133 shape ({...input, answers:{[question text]: label}}) and check
 *      the model's final text repeats the chosen answer.
 *
 * ── FINDINGS (verified live 2026-08-13, claude 2.1.231) ──
 * (a) CONFIRMED — a prompt-worthy tool call (Bash with a file redirect) invokes the configured
 *     MCP approve tool; the .mcp.json `headers.Authorization` bearer arrives on every POST.
 * (b) CONFIRMED — {behavior:"allow", updatedInput} runs the tool; {behavior:"deny", message}
 *     blocks it (command never executed) and the deny message is surfaced to the model.
 * (c) CONFIRMED — AskUserQuestion arrives through the SAME approve channel, and answering with
 *     the questions.ts:118-133 shape ({...input, answers:{[question text]: label}}) injects the
 *     answer (the model repeated the picked label). NO PreToolUse-hook fallback needed: Task 4
 *     routes AskUserQuestion inside the approve tool.
 * (+) CC's own engine auto-allows safe commands (bare `echo` never reached approve) — exactly
 *     the "settings-allowlisted call produces no dialog" acceptance behavior, for free.
 * MCP server contract that sufficed: streamable HTTP, POST-only JSON-RPC — initialize,
 * notifications (no id → 202), tools/list, tools/call returning
 * {content:[{type:"text", text: JSON.stringify(PermissionResult)}]}.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BEARER = "probe-bearer-12345";
const calls: { tool: string; input: unknown; headersOk: boolean }[] = [];
let mode: "allow" | "deny" = "allow";
let questionAnswerLabel = "Green";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method !== "POST") return new Response("ok", { status: 200 });
    const headersOk = req.headers.get("authorization") === `Bearer ${BEARER}`;
    const body = (await req.json()) as { jsonrpc: string; id?: number | string; method: string; params?: any };
    const reply = (result: unknown) =>
      Response.json({ jsonrpc: "2.0", id: body.id, result });
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
              inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, additionalProperties: true },
            },
          ],
        });
      case "tools/call": {
        const args = body.params?.arguments ?? {};
        calls.push({ tool: String(args.tool_name), input: args.input, headersOk });
        console.log(`\x1b[36m[approve]\x1b[0m tool=${args.tool_name} headersOk=${headersOk} input=${JSON.stringify(args.input).slice(0, 200)}`);
        let result: Record<string, unknown>;
        if (mode === "deny") {
          result = { behavior: "deny", message: "denied by probe" };
        } else if (args.tool_name === "AskUserQuestion") {
          const qs = (args.input?.questions ?? []) as { question?: string }[];
          const answers: Record<string, string> = {};
          for (const q of qs) if (q?.question) answers[q.question] = questionAnswerLabel;
          result = { behavior: "allow", updatedInput: { ...args.input, answers } };
        } else {
          result = { behavior: "allow", updatedInput: args.input };
        }
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
      }
      default:
        // notifications (no id) get an empty 202
        return body.id === undefined ? new Response(null, { status: 202 }) : reply({});
    }
  },
});

const cwd = mkdtempSync(join(tmpdir(), "anvil-cc-perm-"));
const mcpConfig = join(cwd, "mcp.json");
writeFileSync(
  mcpConfig,
  JSON.stringify({
    mcpServers: {
      anvild: { type: "http", url: `http://127.0.0.1:${server.port}`, headers: { Authorization: `Bearer ${BEARER}` } },
    },
  }),
);

async function turn(prompt: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(
    [
      "claude", "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--model", "haiku",
      "--permission-mode", "default",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--mcp-config", mcpConfig,
      "--permission-prompt-tool", "mcp__anvild__approve",
    ],
    { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) console.error(`turn exited ${code}: ${err.slice(-400)}`);
  return { out, code };
}

console.log("── A: Bash under default mode, approve → allow ──");
mode = "allow";
const a = await turn('Run this exact bash command: echo probe-ran-$((6*7)) > out.txt && cat out.txt . Then reply with the file contents.');
const aCalls = calls.length;
console.log(`approve calls: ${aCalls}; ran: ${a.out.includes("probe-ran-42")}; headersOk: ${calls.every((c) => c.headersOk)}`);

console.log("── B: Bash under default mode, approve → deny ──");
mode = "deny";
const before = calls.length;
const b = await turn("Run this exact bash command: echo should-never-run-99 > deny.txt && cat deny.txt . Report what happened.");
const bAttempted = b.out.split("\n").some((l) => l.includes('"name":"Bash"'));
const bDeniedMsg = b.out.includes("denied by probe");
console.log(`approve calls: ${calls.length - before}; attemptedBash: ${bAttempted}; sawDenyMessage: ${bDeniedMsg}; leaked: ${b.out.includes("should-never-run-99\\n") || b.out.includes('"stdout":"should-never-run-99')}`);

console.log("── C: AskUserQuestion via the same channel? ──");
mode = "allow";
const beforeC = calls.length;
const c = await turn(
  "Use the AskUserQuestion tool to ask me ONE question: what is my favorite color, offering options Red, Green, Blue. Then reply with exactly the color I picked, one word.",
);
const askCalls = calls.slice(beforeC).filter((x) => x.tool === "AskUserQuestion");
console.log(`approve calls: ${calls.length - beforeC}; AskUserQuestion via approve: ${askCalls.length}; model echoed answer: ${/green/i.test(c.out.split("\n").filter((l) => l.includes('"type":"result"')).join(""))}`);

server.stop(true);
process.exit(0);
