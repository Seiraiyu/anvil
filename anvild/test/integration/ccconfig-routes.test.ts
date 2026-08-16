/**
 * The `~/.claude` config REST surface (cc-config design §7). Reads are tailnet-gated like the rest
 * of /api/cc/v1; writes additionally require a JSON content-type, matching /apply — installing a
 * plugin is code execution on this box and an auto-mode edit moves the safety gate.
 *
 * The service is injected, so nothing here shells out to a real `claude` or touches a real
 * ~/.claude (ground rules).
 */
import { test, expect } from "bun:test";
import { bootServer } from "../helpers";
import { CcConfigService, type CcConfigServiceDeps } from "../../src/session/ccconfig-service";

const EMPTY = { allow: [], soft_deny: [], hard_deny: [], environment: [] };

function fakeService(overrides: Partial<CcConfigServiceDeps> = {}): CcConfigService {
  return new CcConfigService({
    listPlugins: async () => [
      { id: "a@m", name: "a", marketplace: "m", version: "1", enabled: true, scope: "user", mcpServers: [] },
    ],
    listAvailable: async () => [],
    pluginOp: async () => "installed",
    listMarketplaces: async () => [{ name: "m" }],
    marketplaceOp: async () => "ok",
    listMcp: async () => [{ name: "srv", connected: true }],
    addMcp: async () => "ok",
    removeMcp: async () => "ok",
    readAutoMode: async () => ({ ...EMPTY, allow: ["$defaults", "mine"] }),
    readAutoModeDefaults: async () => ({ ...EMPTY, allow: ["builtin"] }),
    writeAutoMode: () => {},
    critiqueAutoMode: async () => "your rules look fine",
    resetAutoMode: async () => {},
    listMemory: () => [{ name: "MEMORY.md", bytes: 10, modified: "2026-01-01T00:00:00.000Z" }],
    readMemory: () => ({ text: "hello\n", modified: "2026-01-01T00:00:00.000Z" }),
    writeMemory: () => ({ modified: "2026-01-02T00:00:00.000Z" }),
    deleteMemory: () => {},
    memoryBudget: () => ({ lines: 1, bytes: 6, state: "ok" }),
    readMemorySettings: () => ({ autoMemoryEnabled: true, autoMemoryDirectory: undefined }),
    writeMemorySettings: () => {},
    ccEnv: () => ({}),
    memoryDir: () => "/tmp/fake-memory",
    ...overrides,
  });
}

const JSON_HEADERS = { "content-type": "application/json" };

async function withServer(
  svc: CcConfigService,
  fn: (base: string) => Promise<void>,
  // biome-ignore lint: test helper
): Promise<void> {
  const srv = await bootServer({ ccConfig: svc });
  try {
    await fn(srv.base);
  } finally {
    srv.cleanup();
  }
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────

test("GET /api/cc/v1/plugins returns the installed list", async () => {
  await withServer(fakeService(), async (base) => {
    const res = await fetch(`${base}/api/cc/v1/plugins`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: { id: string }[] };
    expect(body.plugins[0]!.id).toBe("a@m");
  });
});

test("GET /api/cc/v1/mcp returns servers with status", async () => {
  await withServer(fakeService(), async (base) => {
    const body = (await (await fetch(`${base}/api/cc/v1/mcp`)).json()) as { servers: { name: string }[] };
    expect(body.servers[0]!.name).toBe("srv");
  });
});

test("GET /api/cc/v1/marketplaces and /plugins/available answer", async () => {
  await withServer(fakeService(), async (base) => {
    expect((await fetch(`${base}/api/cc/v1/marketplaces`)).status).toBe(200);
    expect((await fetch(`${base}/api/cc/v1/plugins/available`)).status).toBe(200);
  });
});

test("GET /api/cc/v1/automode returns BOTH the effective config and the built-in defaults", async () => {
  await withServer(fakeService(), async (base) => {
    const body = (await (await fetch(`${base}/api/cc/v1/automode`)).json()) as {
      config: { allow: string[] };
      defaults: { allow: string[] };
    };
    // Without the defaults the client cannot render the $defaults splice preview, which is the
    // whole mechanism that stops a user silently discarding CC's built-in rules.
    expect(body.config.allow).toEqual(["$defaults", "mine"]);
    expect(body.defaults.allow).toEqual(["builtin"]);
  });
});

test("GET /api/cc/v1/memory lists files and settings together", async () => {
  await withServer(fakeService(), async (base) => {
    const body = (await (await fetch(`${base}/api/cc/v1/memory`)).json()) as {
      files: { name: string }[];
      settings: { autoMemoryEnabled: boolean };
    };
    expect(body.files[0]!.name).toBe("MEMORY.md");
    expect(body.settings.autoMemoryEnabled).toBe(true);
  });
});

test("GET a single memory file carries the budget CC will apply", async () => {
  await withServer(fakeService(), async (base) => {
    const body = (await (await fetch(`${base}/api/cc/v1/memory/MEMORY.md`)).json()) as {
      text: string;
      budget: { state: string };
    };
    expect(body.text).toBe("hello\n");
    expect(body.budget.state).toBe("ok");
  });
});

test("/memory/settings resolves to the settings route, not the per-file pattern", async () => {
  await withServer(fakeService(), async (base) => {
    // `settings` would otherwise match /memory/([^/]+) and be read as a FILE named "settings".
    const body = (await (await fetch(`${base}/api/cc/v1/memory/settings`)).json()) as {
      autoMemoryEnabled?: boolean;
      text?: string;
    };
    expect(body.autoMemoryEnabled).toBe(true);
    expect(body.text).toBeUndefined();
  });
});

test("a memory read before any turn has run is a 400 with an actionable reason, not a 500", async () => {
  await withServer(fakeService({ memoryDir: () => undefined }), async (base) => {
    const res = await fetch(`${base}/api/cc/v1/memory`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/run a turn/i);
  });
});

test("an adapter failure surfaces the CLI's own message as a 500", async () => {
  await withServer(
    fakeService({
      listPlugins: async () => {
        throw new Error("marketplace unreachable");
      },
    }),
    async (base) => {
      const res = await fetch(`${base}/api/cc/v1/plugins`);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toMatch(/marketplace unreachable/);
    },
  );
});

// ── writes ──────────────────────────────────────────────────────────────────────────────────────

test("POST /api/cc/v1/plugins/install requires JSON content-type", async () => {
  await withServer(fakeService(), async (base) => {
    const res = await fetch(`${base}/api/cc/v1/plugins/install`, { method: "POST", body: "id=a" });
    expect(res.status).toBe(415);
  });
});

test("POST install returns the CLI's output", async () => {
  await withServer(fakeService(), async (base) => {
    const res = await fetch(`${base}/api/cc/v1/plugins/install`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: "a@m" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { output: string }).output).toBe("installed");
  });
});

test("an unknown op is a 400, not a spawn", async () => {
  let spawned = 0;
  await withServer(
    fakeService({ pluginOp: async () => (spawned++, "ok") }),
    async (base) => {
      const res = await fetch(`${base}/api/cc/v1/plugins/nope`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
      expect(res.status).toBe(400);
    },
  );
  expect(spawned).toBe(0);
});

test("install without an id is a 400", async () => {
  await withServer(fakeService(), async (base) => {
    const res = await fetch(`${base}/api/cc/v1/plugins/install`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    expect(res.status).toBe(400);
  });
});

test("POST /api/cc/v1/mcp add and remove both route to the service", async () => {
  const seen: string[] = [];
  await withServer(
    fakeService({
      addMcp: async (n) => (seen.push(`add:${n}`), "ok"),
      removeMcp: async (n) => (seen.push(`remove:${n}`), "ok"),
    }),
    async (base) => {
      const post = (body: unknown) =>
        fetch(`${base}/api/cc/v1/mcp`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      expect((await post({ op: "add", name: "sentry", config: { type: "http" } })).status).toBe(200);
      expect((await post({ op: "remove", name: "sentry" })).status).toBe(200);
      expect((await post({ op: "sudo", name: "sentry" })).status).toBe(400);
    },
  );
  expect(seen).toEqual(["add:sentry", "remove:sentry"]);
});

test("PUT /api/cc/v1/automode writes the four sections through", async () => {
  let written: Record<string, string[]> | undefined;
  await withServer(
    fakeService({ writeAutoMode: (cfg) => void (written = cfg as never) }),
    async (base) => {
      const res = await fetch(`${base}/api/cc/v1/automode`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ config: { allow: ["$defaults", "mine"] } }),
      });
      expect(res.status).toBe(200);
    },
  );
  expect(written).toEqual({ allow: ["$defaults", "mine"], soft_deny: [], hard_deny: [], environment: [] });
});

test("PUT /api/cc/v1/automode rejects a non-array section rather than writing junk", async () => {
  let called = 0;
  await withServer(fakeService({ writeAutoMode: () => void called++ }), async (base) => {
    const res = await fetch(`${base}/api/cc/v1/automode`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ config: { allow: "not an array" } }),
    });
    expect(res.status).toBe(400);
  });
  expect(called).toBe(0);
});

test("critique and reset are reachable and gated on content-type", async () => {
  await withServer(fakeService(), async (base) => {
    const c = await fetch(`${base}/api/cc/v1/automode/critique`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    expect(((await c.json()) as { critique: string }).critique).toMatch(/look fine/);
    expect((await fetch(`${base}/api/cc/v1/automode/reset`, { method: "POST", body: "x" })).status).toBe(415);
  });
});

test("a stale memory write is a 409 — losing the race to Claude is ordinary, not a server fault", async () => {
  await withServer(
    fakeService({
      writeMemory: () => {
        throw new Error("refusing write: MEMORY.md changed on disk since it was read");
      },
    }),
    async (base) => {
      const res = await fetch(`${base}/api/cc/v1/memory/MEMORY.md`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ text: "v2", expectedModified: "1999-01-01T00:00:00.000Z" }),
      });
      expect(res.status).toBe(409);
    },
  );
});

test("a successful memory write returns the new mtime; DELETE removes", async () => {
  const seen: string[] = [];
  await withServer(
    fakeService({
      writeMemory: (_d, n) => (seen.push(`write:${n}`), { modified: "2026-01-02T00:00:00.000Z" }),
      deleteMemory: (_d, n) => void seen.push(`delete:${n}`),
    }),
    async (base) => {
      const w = await fetch(`${base}/api/cc/v1/memory/notes.md`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ text: "hi" }),
      });
      expect(((await w.json()) as { modified: string }).modified).toBe("2026-01-02T00:00:00.000Z");
      const d = await fetch(`${base}/api/cc/v1/memory/notes.md`, { method: "DELETE", headers: JSON_HEADERS });
      expect(d.status).toBe(200);
    },
  );
  expect(seen).toEqual(["write:notes.md", "delete:notes.md"]);
});

test("a memory write without text is a 400", async () => {
  await withServer(fakeService(), async (base) => {
    const res = await fetch(`${base}/api/cc/v1/memory/notes.md`, { method: "PUT", headers: JSON_HEADERS, body: "{}" });
    expect(res.status).toBe(400);
  });
});

test("an encoded filename survives the route pattern", async () => {
  const seen: string[] = [];
  await withServer(
    fakeService({ readMemory: (_d, n) => (seen.push(n), { text: "x", modified: "2026-01-01T00:00:00.000Z" }) }),
    async (base) => {
      await fetch(`${base}/api/cc/v1/memory/${encodeURIComponent("my notes.md")}`);
    },
  );
  expect(seen).toEqual(["my notes.md"]);
});

test("every write verb rejects a non-JSON content-type", async () => {
  await withServer(fakeService(), async (base) => {
    const cases: [string, string][] = [
      ["POST", "/api/cc/v1/marketplaces"],
      ["POST", "/api/cc/v1/mcp"],
      ["PUT", "/api/cc/v1/automode"],
      ["POST", "/api/cc/v1/automode/critique"],
      ["PUT", "/api/cc/v1/memory/settings"],
      ["PUT", "/api/cc/v1/memory/notes.md"],
    ];
    for (const [method, path] of cases) {
      const res = await fetch(`${base}${path}`, { method, body: "not json" });
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 415`);
    }
  });
});

// ── sync (task 22) ──────────────────────────────────────────────────────────────────────────────

test("sync/apply reports PER-ITEM results and never claims success when one failed", async () => {
  const attempted: string[] = [];
  await withServer(
    fakeService({
      pluginOp: async (_op, id) => {
        attempted.push(id);
        if (id === "bad@m") throw new Error("marketplace unreachable");
        return "ok";
      },
    }),
    async (base) => {
      const res = await fetch(`${base}/api/cc/v1/sync/apply`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ install: ["good@m", "bad@m", "also-good@m"] }),
      });
      expect(res.status).toBe(200); // the REQUEST succeeded; the items are reported individually
      const body = (await res.json()) as { ok: boolean; results: { id: string; ok: boolean; error?: string }[] };
      expect(body.ok).toBe(false); // design §7: one failure means NOT overall success
      expect(body.results.map((r) => [r.id, r.ok])).toEqual([
        ["good@m", true],
        ["bad@m", false],
        ["also-good@m", true],
      ]);
      expect(body.results.find((r) => r.id === "bad@m")!.error).toMatch(/marketplace unreachable/);
    },
  );
  // A failure mid-run must not abort the rest — the user ticked three rows and gets three verdicts.
  expect(attempted).toEqual(["good@m", "bad@m", "also-good@m"]);
});

test("sync/apply runs removals LAST, so a failed install leaves the box as it was", async () => {
  const order: string[] = [];
  await withServer(
    fakeService({ pluginOp: async (op, id) => (order.push(`${op}:${id}`), "ok") }),
    async (base) => {
      await fetch(`${base}/api/cc/v1/sync/apply`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ remove: ["old@m"], install: ["new@m"], update: ["mid@m"] }),
      });
    },
  );
  expect(order).toEqual(["install:new@m", "update:mid@m", "uninstall:old@m"]);
});

test("sync/apply with nothing ticked is a clean no-op", async () => {
  let called = 0;
  await withServer(fakeService({ pluginOp: async () => (called++, "ok") }), async (base) => {
    const res = await fetch(`${base}/api/cc/v1/sync/apply`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    const body = (await res.json()) as { ok: boolean; results: unknown[] };
    expect(body).toEqual({ ok: true, results: [] });
  });
  expect(called).toBe(0);
});

test("sync/plan rejects a missing or non-absolute sourceUrl before reaching out", async () => {
  await withServer(fakeService(), async (base) => {
    const post = (body: unknown) =>
      fetch(`${base}/api/cc/v1/sync/plan`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    expect((await post({})).status).toBe(400);
    expect((await post({ sourceUrl: "not-a-url" })).status).toBe(400);
  });
});

test("sync/plan diffs a real source server against this one", async () => {
  // Boot a SECOND server to act as the sync source — the diff is a genuine cross-box read.
  const sourceSrv = await bootServer({
    ccConfig: fakeService({
      listPlugins: async () => [
        { id: "shared@m", name: "shared", marketplace: "m", version: "1", enabled: true, scope: "user", mcpServers: [] },
        { id: "only-on-source@m", name: "only-on-source", marketplace: "m", version: "1", enabled: true, scope: "user", mcpServers: [] },
      ],
    }),
  });
  try {
    await withServer(
      fakeService({
        listPlugins: async () => [
          { id: "shared@m", name: "shared", marketplace: "m", version: "1", enabled: true, scope: "user", mcpServers: [] },
          { id: "only-on-target@m", name: "only-on-target", marketplace: "m", version: "1", enabled: true, scope: "user", mcpServers: [] },
        ],
      }),
      async (base) => {
        const res = await fetch(`${base}/api/cc/v1/sync/plan`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ sourceUrl: sourceSrv.base }),
        });
        expect(res.status).toBe(200);
        const { diff } = (await res.json()) as {
          diff: { plugins: { install: { id: string }[]; remove: { id: string; selected: boolean }[] } };
        };
        expect(diff.plugins.install.map((x) => x.id)).toEqual(["only-on-source@m"]);
        expect(diff.plugins.remove.map((x) => x.id)).toEqual(["only-on-target@m"]);
        expect(diff.plugins.remove[0]!.selected).toBe(false); // never pre-ticked for destruction
      },
    );
  } finally {
    sourceSrv.cleanup();
  }
});

test("sync/plan surfaces a FAILING source as an error, not an empty diff", async () => {
  // An empty diff here would read as "the boxes already match" — the most dangerous possible
  // misreport for a sync feature, since the user would conclude there is nothing to do.
  // (A closed port is not used as the stimulus: connecting to one hangs rather than refusing under
  // WSL, which made the test time out instead of asserting anything.)
  const sourceSrv = await bootServer({
    ccConfig: fakeService({
      listPlugins: async () => {
        throw new Error("source box is broken");
      },
    }),
  });
  try {
    await withServer(fakeService(), async (base) => {
      const res = await fetch(`${base}/api/cc/v1/sync/plan`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ sourceUrl: sourceSrv.base }),
      });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toMatch(/answered 500/);
    });
  } finally {
    sourceSrv.cleanup();
  }
});
