/**
 * [Phase 4] OutboxQueue — the persisted offline-write queue extracted from main.ts. Tested with a
 * plain fake Storage (no DOM needed): load, enqueue, replace (flush leftover), predicate removal
 * (drop a rejected create's dependents), and resilience to corrupt data / a quota-throwing save.
 */
import { test, expect } from "bun:test";
import { OutboxQueue, newCid, type OutboxItem } from "../../web/src/outbox";

function fakeStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set("anvil.outbox", initial);
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}
const item = (cid: string, o: Partial<OutboxItem> = {}): OutboxItem => ({ cid, cmd: { type: "prompt.send" }, ...o });

test("loads an existing queue from storage", () => {
  const s = fakeStorage(JSON.stringify([item("a"), item("b")]));
  const q = new OutboxQueue(s, "anvil.outbox");
  expect(q.size).toBe(2);
  expect(q.list().map((i) => i.cid)).toEqual(["a", "b"]);
});

test("enqueue appends and persists", () => {
  const s = fakeStorage();
  const q = new OutboxQueue(s, "anvil.outbox");
  q.enqueue(item("a"));
  expect(q.size).toBe(1);
  expect(JSON.parse(s.map.get("anvil.outbox")!)).toHaveLength(1);
});

// ── cc plan 4 task 6 / plan 8 parity: a client that queued commands PRE-upgrade (protocol delta 1,
// autonomy→permissionMode) must flush valid post-upgrade shapes after the deploy straddle. ──

test("pre-upgrade queued session.create is migrated on load (autonomy → permissionMode)", () => {
  const legacy = {
    cid: "old1",
    tempId: "tmp_1",
    serverUrl: "http://hub:7701",
    cmd: { type: "session.create", source: "existing-dir", cwd: "/x", autonomy: "mostly-autonomous" },
  };
  const q = new OutboxQueue(fakeStorage(JSON.stringify([legacy])), "anvil.outbox");
  const m = q.list()[0]!;
  expect(m.cmd.permissionMode).toBe("auto"); // D-6 retargeted `mostly-autonomous` off bypassPermissions
  expect("autonomy" in m.cmd).toBe(false);
  // The reconcile envelope survives the rewrite.
  expect(m.tempId).toBe("tmp_1");
  expect(m.serverUrl).toBe("http://hub:7701");
  expect(m.cmd.cwd).toBe("/x");
});

test("pre-upgrade session.set_autonomy becomes session.set_permission_mode; unknown policy falls back", () => {
  const s = fakeStorage(
    JSON.stringify([
      { cid: "a", cmd: { type: "session.set_autonomy", sessionId: "s1", policy: "allowlist" } },
      { cid: "b", cmd: { type: "session.set_autonomy", sessionId: "s2", policy: "never-seen" } },
      { cid: "c", cmd: { type: "session.create", source: "existing-dir", autonomy: "??" } },
    ]),
  );
  const q = new OutboxQueue(s, "anvil.outbox");
  const [a, b, c] = q.list();
  expect(a!.cmd).toEqual({ type: "session.set_permission_mode", sessionId: "s1", mode: "default" });
  expect(b!.cmd).toEqual({ type: "session.set_permission_mode", sessionId: "s2", mode: "default" });
  expect(c!.cmd.permissionMode).toBe("default");
});

test("post-upgrade items pass through the migration untouched", () => {
  const modern = { cid: "m", cmd: { type: "session.create", source: "existing-dir", permissionMode: "plan" } };
  const q = new OutboxQueue(fakeStorage(JSON.stringify([modern, item("p")])), "anvil.outbox");
  expect(q.list()[0]!.cmd).toEqual(modern.cmd);
  expect(q.list()[1]!.cmd).toEqual({ type: "prompt.send" });
});

test("replace swaps the queue and persists (flush leftover)", () => {
  const s = fakeStorage(JSON.stringify([item("a"), item("b")]));
  const q = new OutboxQueue(s, "anvil.outbox");
  q.replace([item("b")]); // 'a' was sent; 'b' stays
  expect(q.list().map((i) => i.cid)).toEqual(["b"]);
  expect(JSON.parse(s.map.get("anvil.outbox")!)).toHaveLength(1);
});

test("removeWhere drops matching items (a rejected create + its dependents)", () => {
  const s = fakeStorage();
  const q = new OutboxQueue(s, "anvil.outbox");
  q.enqueue(item("create", { tempId: "pending_1" }));
  q.enqueue(item("prompt", { cmd: { type: "prompt.send", sessionId: "pending_1" } }));
  q.enqueue(item("other", { cmd: { type: "prompt.send", sessionId: "real_9" } }));
  q.removeWhere((i) => i.cmd.sessionId === "pending_1" || i.tempId === "pending_1");
  expect(q.list().map((i) => i.cid)).toEqual(["other"]);
});

test("removeWhere is a no-op (no write) when nothing matches", () => {
  const s = fakeStorage(JSON.stringify([item("a")]));
  let writes = 0;
  const wrapped = { ...s, setItem: (k: string, v: string) => (writes++, s.setItem(k, v)) };
  const q = new OutboxQueue(wrapped, "anvil.outbox");
  q.removeWhere((i) => i.cid === "zzz");
  expect(writes).toBe(0);
  expect(q.size).toBe(1);
});

test("a corrupt stored value loads as empty (never throws)", () => {
  const q = new OutboxQueue(fakeStorage("{not json"), "anvil.outbox");
  expect(q.size).toBe(0);
});

test("a quota-throwing save is swallowed; the in-memory queue stays correct", () => {
  const throwing = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); } };
  const q = new OutboxQueue(throwing, "anvil.outbox");
  expect(() => q.enqueue(item("a"))).not.toThrow();
  expect(q.size).toBe(1);
});

test("newCid returns distinct ids", () => {
  expect(newCid()).not.toBe(newCid());
});
