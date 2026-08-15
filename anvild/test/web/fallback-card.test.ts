/**
 * Guards the fallback ContentBlock rendering (cc-cli-transport plan 3, design §4.7 delta 3):
 * an unrecognized CC output block renders as a COLLAPSED <details> card — inspectable, never
 * dropped, never dominating the pane — with the raw JSON in textContent (untrusted payload,
 * no innerHTML injection). Rides commitAssistant like every other ContentBlock.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { ContentBlock } from "../../protocol";

let convo: typeof import("../../web/src/conversation");

const HTML = `<!doctype html><html><body>
  <div id="conversation"></div>
  <button id="scroll-bottom" hidden></button>
  <button id="stop" hidden></button>
  <div id="toast"></div>
  <div id="modal-root"></div>
  <div id="menu-root"></div>
</body></html>`;

beforeAll(async () => {
  installDom({ html: HTML });
  convo = await import("../../web/src/conversation");
  convo.initConversation({
    activeId: () => "s1",
    activeServer: () => ({ url: "https://hub.test" }) as never,
    sessions: new Map(),
    environments: new Map(),
    snapshotLoaded: new Set(),
    saveConvoCache: () => {},
    setStatus: () => {},
    panelView: () => null,
    renderLinks: () => {},
  } as never);
});
afterAll(() => uninstallDom());

test("a fallback block renders as a collapsed details card with the raw JSON", () => {
  const blocks: ContentBlock[] = [
    { kind: "markdown", rendered: { source: "hi", html: "<p>hi</p>" } },
    { kind: "fallback", ccType: "shiny_new_thing", json: '{\n "x": "<script>alert(1)</script>"\n}' },
  ];
  convo.commitAssistant(blocks);
  // Query via the module's own root: conversation.ts binds #conversation at FIRST import, so under
  // the full suite `document` here can be a different (fresh) JSDOM than the one the card landed in.
  const card = convo.conversation.querySelector(".fallback-card details") as HTMLDetailsElement;
  expect(card).not.toBeNull();
  expect(card.open).toBe(false); // collapsed by default
  expect(card.querySelector("summary")!.textContent).toContain("shiny_new_thing");
  const pre = card.querySelector("pre")!;
  expect(pre.textContent).toContain("<script>alert(1)</script>"); // as TEXT…
  expect(pre.innerHTML).not.toContain("<script>"); // …never as markup
});
