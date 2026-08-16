/**
 * `claude mcp list` is text-only (no --json), so this parser is a KNOWN maintenance point
 * (design §4.3). Its contract is therefore: extract what it can, and degrade to `raw` for any
 * line it does not understand — never throw, because a CLI format change must not break the page.
 *
 * REAL below is verbatim from claude 2.1.233 (paths anonymised), so these tests pin the shape the
 * daemon actually meets rather than an idealised one.
 */
import { test, expect } from "bun:test";
import { parseMcpList, listMcpServers, addMcpServer, removeMcpServer } from "../../src/cc/mcp";
import type { CommandRunner } from "../../src/cc/install";

const REAL = `Checking MCP server health…

claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✘ Failed to connect
plugin:episodic-memory:episodic-memory: node /home/u/.claude/x.js - ✔ Connected`;

test("parses the real output into name/target/status", () => {
  const out = parseMcpList(REAL);
  expect(out).toHaveLength(3);
  expect(out[0]).toMatchObject({
    name: "claude.ai Google Drive",
    target: "https://drivemcp.googleapis.com/mcp/v1",
    connected: true,
  });
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

// ── Beyond the plan: this parser is explicitly a maintenance point, so pin the degradation
// behaviour that keeps a CLI format change from taking the page down. ──

test("a URL target survives the name split (the colon in https: must not win)", () => {
  const [row] = parseMcpList("sentry: https://mcp.sentry.dev/mcp - ✔ Connected");
  expect(row).toMatchObject({ name: "sentry", target: "https://mcp.sentry.dev/mcp", connected: true });
});

test("failure wording variants all read as disconnected", () => {
  for (const status of ["✘ Failed to connect", "✘ Connection error", "✘ error: connected refused"]) {
    const [row] = parseMcpList(`x: y - ${status}`);
    expect(row!.connected).toBe(false);
  }
});

test("a wholly reformatted output degrades to raw rows instead of throwing", () => {
  const out = parseMcpList("┌─ servers ─┐\n│ sentry ok │\n└───────────┘");
  expect(out).toHaveLength(3);
  expect(out.every((r) => r.raw === true)).toBe(true);
  expect(out.every((r) => r.connected === false)).toBe(true);
});

test("addMcpServer's JSON argument is one argv entry, never shell-split", async () => {
  const { run, calls } = rec("added");
  // A command with spaces and quotes is exactly the case that would break under word splitting.
  await addMcpServer("local", { command: "node", args: ["--flag", "a b c"], env: { K: "v v" } }, { run });
  expect(calls[0]).toHaveLength(5); // claude + mcp add-json <name> <json>
  expect(JSON.parse(calls[0]![4]!)).toEqual({ command: "node", args: ["--flag", "a b c"], env: { K: "v v" } });
});

test("addMcpServer validates the name before spawning too", async () => {
  const { run, calls } = rec("ok");
  await expect(addMcpServer("a`id`", { type: "http" }, { run })).rejects.toThrow(/invalid mcp server name/i);
  expect(calls).toHaveLength(0);
});

test("a space-bearing name is allowed — the CLI's own servers have them", async () => {
  const { run, calls } = rec("ok");
  await removeMcpServer("claude.ai Google Drive", { run });
  expect(calls[0]!.slice(1)).toEqual(["mcp", "remove", "claude.ai Google Drive"]);
});

test("a nonzero exit surfaces the CLI's message", async () => {
  const { run } = rec("no such server", 1);
  await expect(removeMcpServer("nope", { run })).rejects.toThrow(/no such server/);
});
