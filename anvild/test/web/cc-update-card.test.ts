/**
 * Guards the managed Claude Code card row (plan 2 task 8, design §4.8):
 *   - no row renders for a daemon without the "cc-update" capability (old servers show no
 *     dead controls);
 *   - the row fills in the current version from /api/cc/v1/status and shows Rollback only
 *     when a `previous` install exists;
 *   - Check reveals Update when the bucket is ahead; Update POSTs /apply and polls /status
 *     to a terminal phase, painting it into the card's output pane.
 * serverFetch rides the global fetch, so the daemon is faked with a URL-routing fetch stub.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { Server } from "../../web/src/fleet";

let fleet: typeof import("../../web/src/fleet");

const HTML = `<!doctype html><html><body>
  <div id="cards"></div>
  <div id="toast"></div>
</body></html>`;

const URL_BASE = "https://member.test:7701";

function srvWith(caps: string[] | undefined): Server {
  return { url: URL_BASE, id: "m", name: "member", sock: null, status: "connected", capabilities: caps } as unknown as Server;
}

// URL-routed fetch stub; tests mutate `statusBody` / read `calls` to drive and observe the flow.
const calls: { url: string; method: string; body?: string }[] = [];
let statusBody: Record<string, unknown> = { phase: "idle" };
let checkBody: Record<string, unknown> = { latest: "9.9.9", updateAvailable: true, current: "1.0.0" };
const realFetch = globalThis.fetch;

beforeAll(async () => {
  installDom({ html: HTML });
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (u.includes("/api/cc/v1/status")) return Response.json(statusBody);
    if (u.includes("/api/cc/v1/check")) return Response.json(checkBody);
    if (u.includes("/api/cc/v1/apply")) return Response.json(statusBody);
    if (u.includes("/api/cc/v1/rollback")) return Response.json(statusBody);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  fleet = await import("../../web/src/fleet");
});
afterAll(() => {
  globalThis.fetch = realFetch;
  uninstallDom();
});

/** Wait until `cond` holds (async DOM updates settle in microtasks/timers). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition never held");
}

test("no cc row without the cc-update capability", () => {
  expect(fleet.ccCardRowHtml(srvWith(undefined))).toBe("");
  expect(fleet.ccCardRowHtml(srvWith(["stable-update"]))).toBe("");
});

test("row renders, fills in the current version, and gates Rollback on `previous`", async () => {
  statusBody = { phase: "idle", current: "2.1.0", previous: "2.0.0", installed: ["2.0.0", "2.1.0"] };
  const srv = srvWith(["cc-update"]);
  document.getElementById("cards")!.innerHTML = fleet.ccCardRowHtml(srv);
  fleet.wireCcUpdate(srv);
  const id = fleet.cssId(URL_BASE);
  await until(() => document.getElementById(`cc-version-${id}`)!.textContent!.includes("2.1.0"));
  expect(document.getElementById(`cc-version-${id}`)!.textContent).toBe("Claude Code: 2.1.0");
  expect((document.getElementById(`cc-rollback-${id}`) as HTMLButtonElement).hidden).toBe(false);
});

test("Check reveals Update; Update POSTs apply and polls status to healthy", async () => {
  statusBody = { phase: "idle", current: "1.0.0", installed: ["1.0.0"] };
  checkBody = { latest: "9.9.9", updateAvailable: true, current: "1.0.0" };
  const srv = srvWith(["cc-update"]);
  document.getElementById("cards")!.innerHTML = fleet.ccCardRowHtml(srv);
  fleet.wireCcUpdate(srv);
  const id = fleet.cssId(URL_BASE);
  const updateBtn = document.getElementById(`cc-update-${id}`) as HTMLButtonElement;
  expect(updateBtn.hidden).toBe(true);

  (document.getElementById(`cc-check-${id}`) as HTMLButtonElement).click();
  await until(() => !updateBtn.hidden);
  expect(updateBtn.textContent).toBe("Update to 9.9.9");

  statusBody = { phase: "healthy", current: "9.9.9", target: "9.9.9", installed: ["1.0.0", "9.9.9"] };
  calls.length = 0;
  updateBtn.click();
  await until(() => calls.some((c) => c.url.includes("/api/cc/v1/apply") && c.method === "POST"));
  const apply = calls.find((c) => c.url.includes("/api/cc/v1/apply"))!;
  expect(JSON.parse(apply.body!)).toEqual({ target: "9.9.9" });
  const out = document.getElementById(`cc-output-${id}`)!;
  await until(() => (out.textContent ?? "").includes("healthy"));
  expect(out.textContent).toContain("healthy → 9.9.9");
});
