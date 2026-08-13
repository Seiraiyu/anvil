/**
 * Daemon-hosted MCP tool server (plan 5 task 1, design §4.5) — replaces the SDK's
 * createSdkMcpServer for the anvil role tool sets (concierge/team/member/planning). Speaks the
 * same spike-verified streamable-HTTP contract as cc/permission-server.ts; served from the
 * daemon's listener at /api/cc/mcp/<sessionId>/<serverName> with the session bearer.
 *
 * `defineTool` mirrors the SDK `tool()` signature (name, description, zod raw shape, handler)
 * so the four tool modules keep their pure-handler structure — only the import changes. Tool ids
 * stay `mcp__<server>__<tool>` on the CC side because the .mcp.json server names are unchanged.
 */
import { z } from "zod";

export interface AnvilToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface AnvilTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  /** `extra` is accepted (and ignored) for signature-compatibility with the old SDK handler
   *  shape, so the existing handler tests keep passing untouched (plan 5 task 6). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- erased at the store boundary; defineTool is the typed door
  handler: (args: any, extra?: unknown) => Promise<AnvilToolResult> | AnvilToolResult;
}

export interface AnvilToolServer {
  name: string;
  tools: AnvilTool[];
}

/** SDK-`tool()`-shaped definition helper; args reach the handler zod-validated. */
export function defineTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<AnvilToolResult> | AnvilToolResult,
): AnvilTool {
  return { name, description, schema, handler };
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

/** One MCP request against one tool server (route resolves session + bearer + server first). */
export async function handleToolServer(req: Request, server: AnvilToolServer): Promise<Response> {
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
        serverInfo: { name: server.name, version: "1" },
      });
    case "tools/list":
      return rpcResult(body.id, {
        tools: server.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(z.object(t.schema)),
        })),
      });
    case "tools/call": {
      const tool = server.tools.find((t) => t.name === body.params?.name);
      if (!tool) return rpcError(body.id, -32602, `unknown tool: ${body.params?.name}`);
      const parsed = z.object(tool.schema).safeParse(body.params?.arguments ?? {});
      if (!parsed.success) {
        return rpcResult(body.id, {
          content: [{ type: "text", text: `invalid arguments for ${tool.name}: ${parsed.error.message}` }],
          isError: true,
        });
      }
      try {
        const result = await tool.handler(parsed.data);
        return rpcResult(body.id, result);
      } catch (e) {
        return rpcResult(body.id, {
          content: [{ type: "text", text: `${tool.name} failed: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      }
    }
    default:
      return body.id === undefined ? new Response(null, { status: 202 }) : rpcResult(body.id, {});
  }
}
