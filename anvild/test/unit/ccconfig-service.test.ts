/**
 * [P7] CcConfigService guard test — the domain that owns the whole `~/.claude` surface. This
 * isolates the INJECTION CONTRACT: every CLI call and filesystem touch goes through the injected
 * deps (so tests never reach a real ~/.claude), mutations are serialised, and a failing op reports
 * rather than wedging the server.
 */
import { test, expect } from "bun:test";
import { CcConfigService, type CcConfigServiceDeps } from "../../src/session/ccconfig-service";
import type { PluginInfo } from "../../src/cc/plugins";

function harness(overrides: Partial<CcConfigServiceDeps> = {}) {
  const calls: string[] = [];
  const plugins: PluginInfo[] = [
    { id: "a@m", name: "a", marketplace: "m", version: "1.0.0", enabled: true, scope: "user", mcpServers: [] },
  ];
  const empty = { allow: [], soft_deny: [], hard_deny: [], environment: [] };
  const deps: CcConfigServiceDeps = {
    listPlugins: async () => (calls.push("list"), plugins),
    listAvailable: async () => [],
    pluginOp: async (op, id) => (calls.push(`${op}:${id}`), "ok"),
    listMarketplaces: async () => [],
    marketplaceOp: async () => "ok",
    listMcp: async () => [],
    addMcp: async () => "ok",
    removeMcp: async () => "ok",
    readAutoMode: async () => empty,
    readAutoModeDefaults: async () => empty,
    writeAutoMode: () => calls.push("writeAutoMode"),
    critiqueAutoMode: async () => "looks fine",
    resetAutoMode: async () => void calls.push("reset"),
    listMemory: (dir) => (calls.push(`listMemory:${dir}`), []),
    readMemory: () => ({ text: "hello\n", modified: "2026-01-01T00:00:00.000Z" }),
    writeMemory: (_d, name) => (calls.push(`writeMemory:${name}`), { modified: "2026-01-02T00:00:00.000Z" }),
    deleteMemory: (_d, name) => void calls.push(`deleteMemory:${name}`),
    memoryBudget: () => ({ lines: 1, bytes: 6, state: "ok" }),
    readMemorySettings: () => ({ autoMemoryEnabled: true, autoMemoryDirectory: undefined }),
    writeMemorySettings: () => calls.push("writeMemorySettings"),
    ccEnv: () => ({}),
    memoryDir: () => "/tmp/fake-memory",
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
  const { svc } = harness({
    pluginOp: async () => {
      throw new Error("boom");
    },
  });
  await expect(svc.op("install", "a@m")).rejects.toThrow(/boom/);
  await expect(svc.op("install", "a@m")).rejects.toThrow(/boom/); // not "already in progress"
});

// ── Beyond the plan: the lock spans FOUR domains that share one ~/.claude tree, and the memoryDir
// seam is what keeps principle 1 (never derive CC's paths). Both deserve pinning. ──

test("the mutation lock spans domains — an auto-mode write blocks a memory write", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { svc } = harness({ critiqueAutoMode: async () => (await gate, "ok") });
  const first = svc.critique();
  // Both patch ~/.claude/settings.json; letting them interleave would lose one silently.
  await expect(svc.writeMemorySettings({ autoMemoryEnabled: false })).rejects.toThrow(/already in progress/i);
  release();
  await first;
});

test("reads are NOT serialised — a slow install must not make the page unreadable", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { svc } = harness({ pluginOp: async () => (await gate, "ok") });
  const installing = svc.op("install", "a@m");
  // The user's most likely action while an install runs is watching the list. It must still answer.
  expect((await svc.list()).length).toBe(1);
  expect(await svc.mcp()).toEqual([]);
  release();
  await installing;
});

test("memory operations refuse with a clear reason before any turn has reported a memory dir", async () => {
  const { svc, calls } = harness({ memoryDir: () => undefined });
  expect(() => svc.memoryFiles()).toThrow(/run a turn/i);
  expect(() => svc.memoryFile("MEMORY.md")).toThrow(/run a turn/i);
  await expect(svc.writeMemory("x.md", "y")).rejects.toThrow(/run a turn/i);
  await expect(svc.deleteMemory("x.md")).rejects.toThrow(/run a turn/i);
  // Nothing was attempted against a guessed path — deriving one would reimplement CC (principle 1).
  expect(calls.filter((c) => c.includes("emory"))).toEqual([]);
});

test("the memory dir comes from the injected seam, never derived", () => {
  const { svc, calls } = harness({ memoryDir: () => "/somewhere/cc/said" });
  svc.memoryFiles();
  expect(calls).toContain("listMemory:/somewhere/cc/said");
});

test("reading a memory file reports the budget CC will apply to it", () => {
  const { svc } = harness();
  expect(svc.memoryFile("MEMORY.md")).toMatchObject({ text: "hello\n", budget: { state: "ok" } });
});

test("a failed memory write also clears the lock", async () => {
  const { svc } = harness({
    writeMemory: () => {
      throw new Error("disk full");
    },
  });
  await expect(svc.writeMemory("a.md", "x")).rejects.toThrow(/disk full/);
  await expect(svc.writeMemory("a.md", "x")).rejects.toThrow(/disk full/);
});

test("every mutation entry point actually takes the lock", async () => {
  // A mutation added later that forgets exclusive() would silently reintroduce the interleave this
  // service exists to prevent, so enumerate them rather than trusting review.
  const mutations: ((s: CcConfigService) => Promise<unknown>)[] = [
    (s) => s.op("install", "a@m"),
    (s) => s.marketplace("add", "org/repo"),
    (s) => s.addMcp("n", {}),
    (s) => s.removeMcp("n"),
    (s) => s.writeAutoMode({ allow: [], soft_deny: [], hard_deny: [], environment: [] }),
    (s) => s.critique(),
    (s) => s.resetAutoMode(),
    (s) => s.writeMemory("a.md", "x"),
    (s) => s.deleteMemory("a.md"),
    (s) => s.writeMemorySettings({ autoMemoryEnabled: true }),
  ];
  for (const call of mutations) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Hold the lock with a known-slow op, then assert the candidate is refused.
    const { svc } = harness({ listPlugins: async () => [] , pluginOp: async () => (await gate, "ok") });
    const held = svc.op("install", "holder@m");
    await expect(call(svc)).rejects.toThrow(/already in progress/i);
    release();
    await held;
  }
});
