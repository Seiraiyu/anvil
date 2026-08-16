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
