/**
 * The daemon's MCP `approve` endpoint (plan 4 tasks 2+4, design §4.4; Assumption 3 confirmed
 * live by test/tools/probe-cc-permission.ts): the CLI is spawned with
 * `--permission-prompt-tool mcp__anvild__approve`, so every tool call ITS engine would prompt
 * for — including AskUserQuestion — arrives here as an MCP tools/call. We bridge to the
 * UNCHANGED PermissionBroker/QuestionBroker, so the existing permission.request /
 * question.request cards, pushes, and multi-device resolution flows all work verbatim.
 *
 * Wire contract (spike-verified): streamable-HTTP MCP, POST-only JSON-RPC — initialize,
 * notifications (no id → 202), tools/list, and tools/call returning
 * `{content:[{type:"text", text: JSON.stringify(<PermissionResult>)}]}`.
 *
 * `allow_always` is recorded via session.rememberAllow INSIDE the daemon (re-asks are answered
 * here without a card); CC-native config is never touched.
 */
import { newId } from "../util/ids";
import { SUGGESTIONS, type PermissionBroker } from "../agent/permissions";
import { normalizeQuestions, type QuestionBroker } from "../agent/questions";
import type { Session } from "../session/session";

export interface CcPermissionDeps {
  session: Session;
  broker: PermissionBroker;
  questionBroker: QuestionBroker;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

const rpcResult = (id: number | string | undefined, result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id: number | string | undefined, code: number, message: string): Response =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

/** One MCP request for one session (the route resolved session + bearer already). */
export async function handleCcMcp(req: Request, deps: CcPermissionDeps): Promise<Response> {
  let body: RpcRequest;
  try {
    body = (await req.json()) as RpcRequest;
  } catch {
    return rpcError(undefined, -32700, "parse error");
  }
  switch (body.method) {
    case "initialize":
      return rpcResult(body.id, {
        protocolVersion: body.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "anvild", version: "1" },
      });
    case "tools/list":
      return rpcResult(body.id, {
        tools: [
          {
            name: "approve",
            description: "Anvil permission gate: routes this session's CLI permission prompts to every connected device.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                input: { type: "object" },
                tool_use_id: { type: "string" },
              },
              additionalProperties: true,
            },
          },
        ],
      });
    case "tools/call": {
      if (body.params?.name !== "approve") return rpcError(body.id, -32602, `unknown tool: ${body.params?.name}`);
      const args = body.params.arguments ?? {};
      const toolName = String(args.tool_name ?? "");
      const input = (args.input ?? {}) as Record<string, unknown>;
      const result =
        toolName === "AskUserQuestion" ? await handleQuestion(deps, input) : await handlePermission(deps, toolName, input);
      return rpcResult(body.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    }
    default:
      // Notifications (initialized, cancelled, …) carry no id — acknowledge and move on.
      return body.id === undefined ? new Response(null, { status: 202 }) : rpcResult(body.id, {});
  }
}

type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** The permission path — the CLI's engine already decided this call needs a human. */
async function handlePermission(
  deps: CcPermissionDeps,
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  const s = deps.session;
  // A remembered "always allow" answers the re-ask inside the daemon — no card, no round trip.
  if (s.isAlwaysAllowed(toolName)) return { behavior: "allow", updatedInput: input };

  const requestId = newId("perm");
  const answer = deps.broker.request(requestId, s.id);
  s.requestPermission(requestId, toolName, input, SUGGESTIONS(toolName));
  const ans = await answer;

  if (ans.decision === "deny") return { behavior: "deny", message: "denied by user" };
  if (ans.decision === "allow_always") s.rememberAllow(toolName);
  return { behavior: "allow", updatedInput: (ans.updatedInput as Record<string, unknown>) ?? input };
}

/** AskUserQuestion — same channel (spike finding c), same wire shape as questions.ts:118-133. */
async function handleQuestion(deps: CcPermissionDeps, input: Record<string, unknown>): Promise<PermissionResult> {
  const s = deps.session;
  const questions = normalizeQuestions(input.questions);
  // No parseable questions → let the CLI's own tool produce its "did not answer" result.
  if (questions.length === 0) return { behavior: "allow", updatedInput: input };

  const requestId = newId("q");
  const answer = deps.questionBroker.request(requestId, s.id);
  s.requestQuestion(requestId, questions);
  const res = await answer;
  if (res.cancelled || !res.answers || res.answers.length === 0) return { behavior: "allow", updatedInput: input };

  const answers: Record<string, string | string[]> = {};
  const annotations: Record<string, { notes?: string }> = {};
  for (const a of res.answers) {
    if (a.labels.length) answers[a.question] = a.labels.length === 1 ? a.labels[0]! : a.labels;
    if (a.notes?.trim()) annotations[a.question] = { notes: a.notes.trim() };
  }
  const updatedInput: Record<string, unknown> = { ...input, answers };
  if (Object.keys(annotations).length) updatedInput.annotations = annotations;
  return { behavior: "allow", updatedInput };
}
