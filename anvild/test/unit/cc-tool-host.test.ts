/**
 * Guards plan 5 task 1 (design §4.5): the daemon-hosted MCP tool server that replaces the SDK's
 * createSdkMcpServer. Same wire contract the permission server speaks (spike-verified):
 *   - tools/list advertises every tool with a JSON Schema derived from the zod shape;
 *   - tools/call validates args against the shape (bad args ⇒ isError result, not a crash);
 *   - handler results/exceptions map to MCP content;
 *   - notifications get a 202; unknown tools a JSON-RPC error.
 */
import { expect, test } from "bun:test";
import { z } from "zod";
import { defineTool, handleToolServer, type AnvilToolServer } from "../../src/cc/tool-host";

const server: AnvilToolServer = {
  name: "anvil_test",
  tools: [
    defineTool("echo", "Echo the given text back.", { text: z.string().describe("What to echo") }, async ({ text }) => ({
      content: [{ type: "text", text: `echo:${text}` }],
    })),
    defineTool("boom", "Always throws.", {}, async () => {
      throw new Error("kaboom");
    }),
  ],
};

function rpc(method: string, params?: unknown, id: number | null = 1): Request {
  return new Request("http://d/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
  });
}

test("initialize + tools/list advertise the tools with JSON Schemas", async () => {
  const init = (await (await handleToolServer(rpc("initialize", { protocolVersion: "2025-01-01" }), server)).json()) as any;
  expect(init.result.protocolVersion).toBe("2025-01-01");
  expect(init.result.serverInfo.name).toBe("anvil_test");
  const list = (await (await handleToolServer(rpc("tools/list"), server)).json()) as any;
  expect(list.result.tools.map((t: any) => t.name)).toEqual(["echo", "boom"]);
  const echo = list.result.tools[0];
  expect(echo.description).toContain("Echo");
  expect(echo.inputSchema.type).toBe("object");
  expect(echo.inputSchema.properties.text.type).toBe("string");
});

test("tools/call runs the handler with validated args", async () => {
  const res = (await (await handleToolServer(rpc("tools/call", { name: "echo", arguments: { text: "hi" } }), server)).json()) as any;
  expect(res.result.content[0].text).toBe("echo:hi");
});

test("invalid args are an isError tool result, not a crash", async () => {
  const res = (await (await handleToolServer(rpc("tools/call", { name: "echo", arguments: { text: 42 } }), server)).json()) as any;
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("invalid arguments");
});

test("a throwing handler maps to an isError result", async () => {
  const res = (await (await handleToolServer(rpc("tools/call", { name: "boom", arguments: {} }), server)).json()) as any;
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toContain("kaboom");
});

test("unknown tool → JSON-RPC error; notification → 202", async () => {
  const res = (await (await handleToolServer(rpc("tools/call", { name: "nope", arguments: {} }), server)).json()) as any;
  expect(res.error).toBeDefined();
  expect((await handleToolServer(rpc("notifications/initialized", undefined, null), server)).status).toBe(202);
});
