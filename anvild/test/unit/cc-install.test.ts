// Guards design §4.8: versioned installs, atomic current/previous flip, rollback swap.
// Uses real temp dirs + real symlinks (repo convention: never fake the filesystem).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcInstalls, binaryPath } from "../../src/cc/install";

function store(): { cc: CcInstalls; root: string } {
  const root = mkdtempSync(join(tmpdir(), "anvil-cc-install-"));
  return { cc: new CcInstalls(root), root };
}
function fakeInstall(cc: CcInstalls, v: string): void {
  const dir = cc.installDirFor(v);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(binaryPath(dir), "#!/bin/sh\necho fake\n", { mode: 0o755 });
}

test("empty store: no current, no versions", () => {
  const { cc } = store();
  expect(cc.listInstalled()).toEqual([]);
  expect(cc.currentVersion()).toBeUndefined();
});

test("activate flips current; second activate records previous", () => {
  const { cc } = store();
  fakeInstall(cc, "2.1.0"); fakeInstall(cc, "2.2.0");
  cc.activate("2.1.0");
  expect(cc.currentVersion()).toBe("2.1.0");
  cc.activate("2.2.0");
  expect(cc.currentVersion()).toBe("2.2.0");
  expect(cc.previousVersion()).toBe("2.1.0");
  expect(cc.currentBinary()).toBe(binaryPath(cc.installDirFor("2.2.0")));
});

test("activate refuses a version with no binary", () => {
  const { cc } = store();
  expect(() => cc.activate("9.9.9")).toThrow(/not installed/);
});

test("rollback swaps current and previous", () => {
  const { cc } = store();
  fakeInstall(cc, "2.1.0"); fakeInstall(cc, "2.2.0");
  cc.activate("2.1.0"); cc.activate("2.2.0");
  expect(cc.rollback()).toBe("2.1.0");
  expect(cc.currentVersion()).toBe("2.1.0");
  expect(cc.previousVersion()).toBe("2.2.0"); // swap, so rollback is reversible
});

test("rollback with no previous throws", () => {
  const { cc } = store();
  expect(() => cc.rollback()).toThrow(/no previous/);
});
