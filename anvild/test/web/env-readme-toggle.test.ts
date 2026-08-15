/**
 * Regression: the environment card's README toggle must survive a re-render of the environment list.
 *
 * Found by the e2e browser walk (2026-08-14). `toggleReadme` used a module-level `readmeLoaded` Set
 * as its "already fetched" cache, but `renderEnvCards()` recreates every `.env-readme-body` div
 * EMPTY and `hidden`. Any `environments` broadcast (editing an environment is enough) therefore
 * desynced the two: the div was blank while the Set still claimed it was loaded, so the next README
 * click expanded a blank panel — no content, no spinner, no error. The body element is now the cache.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { Environment } from "../../protocol";

let settings: typeof import("../../web/src/settings");
let fleet: typeof import("../../web/src/fleet");

const HTML = `<!doctype html><html><body><div id="env-cards"></div><div id="toast"></div></body></html>`;
const ENV_ID = "env_readme_1";
const README_HTML = "<h1>anvil_test</h1>";

let readmeFetches = 0;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  installDom({ html: HTML, url: "http://127.0.0.1:7801/" });
  settings = await import("../../web/src/settings");
  fleet = await import("../../web/src/fleet");

  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/readme")) {
      readmeFetches++;
      return Response.json({ markdown: { html: README_HTML } });
    }
    return Response.json({});
  }) as typeof fetch;

  const env: Environment = { id: ENV_ID, name: "E2E", repoRoot: "/tmp/repo", isRepo: true } as Environment;
  settings.initSettings({
    sessions: new Map(),
    environments: new Map([[ENV_ID, env]]),
    activeId: () => null,
    sendAwait: async () => ({}) as never,
    setThemePref: () => {},
    showEditPrompt: () => {},
    renderPromptsPanel: () => {},
    updateHeaderAccount: () => {},
  });
  fleet.servers.set(fleet.HUB_URL, {
    url: fleet.HUB_URL, id: "hub", name: "hub", sock: null, status: "connected", capabilities: [],
  } as unknown as (typeof fleet.servers) extends Map<string, infer S> ? S : never);
  fleet.envServer.set(ENV_ID, fleet.HUB_URL);
});
afterAll(() => {
  globalThis.fetch = realFetch;
  uninstallDom();
});

beforeEach(() => {
  readmeFetches = 0;
});

const body = (): HTMLElement => document.getElementById(`readme-${ENV_ID}`)!;
const clickReadme = (): void => document.querySelector<HTMLElement>(".env-readme")!.click();
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("README toggle loads content on first open and hides it on second click", async () => {
  settings.renderEnvCards();
  expect(body().hidden).toBe(true);

  clickReadme();
  await settle();
  expect(body().hidden).toBe(false);
  expect(body().innerHTML).toContain("anvil_test");
  expect(readmeFetches).toBe(1);

  clickReadme(); // collapse
  expect(body().hidden).toBe(true);
});

test("an open README survives being re-opened without refetching (element is the cache)", async () => {
  settings.renderEnvCards();
  clickReadme();
  await settle();
  expect(readmeFetches).toBe(1);

  clickReadme(); // hide
  clickReadme(); // show again — content still in the DOM, so no second fetch
  await settle();
  expect(body().hidden).toBe(false);
  expect(body().innerHTML).toContain("anvil_test");
  expect(readmeFetches).toBe(1);
});

test("REGRESSION: after the env list re-renders, clicking README refetches instead of expanding blank", async () => {
  settings.renderEnvCards();
  clickReadme();
  await settle();
  expect(body().innerHTML).toContain("anvil_test");
  expect(readmeFetches).toBe(1);

  // An `environments` broadcast repaints the list: the body is recreated EMPTY and hidden.
  settings.renderEnvCards();
  expect(body().hidden).toBe(true);
  expect(body().innerHTML).toBe("");

  clickReadme();
  await settle();
  expect(body().hidden).toBe(false);
  expect(body().innerHTML).toContain("anvil_test"); // was "" before the fix
  expect(readmeFetches).toBe(2); // refetched rather than trusting a stale "loaded" flag
});
