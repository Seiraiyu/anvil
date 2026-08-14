/**
 * Guards `repaintPreservingInput` (dom.ts).
 *
 * Settings panels repaint on daemon broadcasts (`auth.status`, `auth.accounts`, `todoist.status`),
 * and those reach EVERY connected device. Each handler replaced the panel's whole innerHTML, so an
 * unrelated account change on another machine silently wiped a token the user was part-way through
 * pasting here. The helper repaints while restoring unsaved typing — but must never clobber a value
 * the fresh markup supplies, or a stale local edit would win over server truth.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";

let dom: typeof import("../../web/src/dom");

beforeAll(async () => {
  installDom({ html: `<!doctype html><html><body><div id="host"></div></body></html>` });
  dom = await import("../../web/src/dom");
});
afterAll(() => uninstallDom());

const host = (): HTMLElement => document.getElementById("host")!;
const paint = (html: string) => () => void (host().innerHTML = html);

test("unsaved typing survives a repaint that blanks the field", () => {
  host().innerHTML = `<input id="key" value="">`;
  const field = document.getElementById("key") as HTMLInputElement;
  field.value = "sk-or-typed-but-not-saved"; // user pasted; never hit Save

  dom.repaintPreservingInput(host(), paint(`<input id="key" value="">`));

  expect((document.getElementById("key") as HTMLInputElement).value).toBe("sk-or-typed-but-not-saved");
});

test("a value supplied by the repaint wins — server truth is never overwritten", () => {
  host().innerHTML = `<input id="label" value="old">`;
  (document.getElementById("label") as HTMLInputElement).value = "local edit";

  dom.repaintPreservingInput(host(), paint(`<input id="label" value="from-server">`));

  expect((document.getElementById("label") as HTMLInputElement).value).toBe("from-server");
});

test("focus and caret return to the field being typed into", () => {
  host().innerHTML = `<input id="a" value=""><input id="b" value="">`;
  const b = document.getElementById("b") as HTMLInputElement;
  b.value = "hello world";
  b.focus();
  b.setSelectionRange(5, 5); // caret after "hello"

  dom.repaintPreservingInput(host(), paint(`<input id="a" value=""><input id="b" value="">`));

  const after = document.getElementById("b") as HTMLInputElement;
  expect(document.activeElement).toBe(after);
  expect(after.value).toBe("hello world");
  expect(after.selectionStart).toBe(5);
});

test("checkboxes and untouched fields are left to the repaint", () => {
  host().innerHTML = `<input id="c" type="checkbox" checked><input id="t" value="">`;
  (document.getElementById("c") as HTMLInputElement).checked = false;

  dom.repaintPreservingInput(host(), paint(`<input id="c" type="checkbox" checked><input id="t" value="">`));

  // Checkbox state is the repaint's business (no typed text to protect), and an empty text field
  // stays empty rather than resurrecting anything.
  expect((document.getElementById("c") as HTMLInputElement).checked).toBe(true);
  expect((document.getElementById("t") as HTMLInputElement).value).toBe("");
});

test("fields without ids are matched positionally, and a shorter repaint drops extras safely", () => {
  host().innerHTML = `<input value=""><input value="">`;
  const [first, second] = [...host().querySelectorAll("input")] as HTMLInputElement[];
  first!.value = "one";
  second!.value = "two";

  expect(() => dom.repaintPreservingInput(host(), paint(`<input value="">`))).not.toThrow();
  expect((host().querySelector("input") as HTMLInputElement).value).toBe("one");
});
