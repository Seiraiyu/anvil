// ── Offline outbox: writes made offline are queued and flushed, in order, on reconnect (arch §8) ──
// This module owns only the QUEUE (the persisted OutboxItem list); the flush/reconcile orchestration
// stays in main.ts because it touches sockets, routing, and session state. Extracted so the queue's
// persistence + mutation logic is unit-testable (inject a Storage; no DOM required).

export interface OutboxItem {
  cid: string;
  cmd: Record<string, unknown> & { type: string };
  tempId?: string; // for session.create: the optimistic local session id to reconcile
  serverUrl?: string; // target server for commands with no sessionId yet (session.create)
}

/** A correlation id for a command awaiting its ack/result. Broadly used, so it lives with the outbox. */
export const newCid = (): string => (crypto.randomUUID ? crypto.randomUUID() : `c_${Date.now()}_${Math.floor(Math.random() * 1e9)}`);

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export class OutboxQueue {
  private items: OutboxItem[];

  constructor(
    private readonly storage: StorageLike = localStorage,
    private readonly key = "anvil.outbox",
  ) {
    this.items = this.load();
  }

  list(): OutboxItem[] {
    return this.items;
  }
  get size(): number {
    return this.items.length;
  }

  enqueue(item: OutboxItem): void {
    this.items.push(item);
    this.save();
  }

  /** Replace the whole queue (used by flush: the items that couldn't be sent stay). */
  replace(items: OutboxItem[]): void {
    this.items = items;
    this.save();
  }

  /** Drop items matching a predicate (used when a queued create is rejected → drop its dependents). */
  removeWhere(pred: (i: OutboxItem) => boolean): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => !pred(i));
    if (this.items.length !== before) this.save();
  }

  private load(): OutboxItem[] {
    try {
      const items = JSON.parse(this.storage.getItem(this.key) ?? "[]") as OutboxItem[];
      return items.map(migrateLegacyAutonomy);
    } catch {
      return [];
    }
  }
  private save(): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.items));
    } catch {
      /* quota — the in-memory queue is still authoritative for this session */
    }
  }
}

// ── cc plan 4 (protocol delta 1) migration ───────────────────────────────────────────────────────
// A command queued OFFLINE before the autonomy→permissionMode rename can be flushed AFTER the
// upgrade (localStorage straddles deploys even under fresh-start). Rewrite the two legacy shapes
// in place: session.create's `autonomy` key, and the session.set_autonomy command itself.
const LEGACY_AUTONOMY_MAP: Record<string, string> = {
  bypass: "bypassPermissions",
  // `auto` is what `mostly-autonomous` always meant: rarely prompted, but with a floor under
  // destructive actions. 3084128 had to settle for `bypassPermissions` as "the closest behavioral
  // match" because CC had no classifier mode yet; D-6 gives the mapping its real target.
  "mostly-autonomous": "auto",
  allowlist: "default",
  "prompt-all": "default",
};

function migrateLegacyAutonomy(item: OutboxItem): OutboxItem {
  const cmd = item.cmd;
  if (cmd.type === "session.create" && typeof cmd.autonomy === "string") {
    const { autonomy, ...rest } = cmd;
    return { ...item, cmd: { ...rest, type: cmd.type, permissionMode: LEGACY_AUTONOMY_MAP[autonomy] ?? "default" } };
  }
  if (cmd.type === "session.set_autonomy") {
    const mode = typeof cmd.policy === "string" ? (LEGACY_AUTONOMY_MAP[cmd.policy] ?? "default") : "default";
    return { ...item, cmd: { type: "session.set_permission_mode", sessionId: cmd.sessionId, mode } };
  }
  return item;
}
