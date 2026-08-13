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

// ── Downloader (plan 2 task 4): direct-download contract verified by probe-cc-installer.ts —
// pinned version + caller-chosen dir, sha256 from the manifest, version from `<bin> --version`.
import { officialDownloader, defaultRun, type CommandRunner } from "../../src/cc/install";
import { readFileSync } from "node:fs";

const BIN_BYTES = new TextEncoder().encode("#!/bin/sh\necho fake-cc\n");
const BIN_SHA = new Bun.CryptoHasher("sha256").update(BIN_BYTES).digest("hex");

function fakeFetch(overrides: Record<string, () => Response> = {}): { fetchFn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (url: RequestInfo | URL) => {
    const u = String(url);
    urls.push(u);
    for (const [suffix, make] of Object.entries(overrides)) if (u.endsWith(suffix)) return make();
    if (u.endsWith("/latest")) return new Response("9.9.9\n");
    if (u.endsWith("/manifest.json")) {
      return Response.json({ platforms: { "linux-x64": { checksum: BIN_SHA } } });
    }
    if (u.endsWith("/claude")) return new Response(BIN_BYTES);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, urls };
}

const okRunner: CommandRunner = async () => ({ code: 0, out: "9.9.9 (Claude Code)" });

test("downloader fetches the pinned version, writes bin/claude, reports --version", async () => {
  const { cc } = store();
  const { fetchFn, urls } = fakeFetch();
  const dl = officialDownloader(fetchFn, "linux-x64");
  const dest = cc.installDirFor("9.9.9");
  const got = await dl("9.9.9", dest, okRunner);
  expect(got.version).toBe("9.9.9");
  expect(urls.some((u) => u.includes("/9.9.9/manifest.json"))).toBe(true);
  expect(urls.some((u) => u.includes("/9.9.9/linux-x64/claude"))).toBe(true);
  expect(readFileSync(binaryPath(dest), "utf8")).toContain("fake-cc");
  expect(cc.listInstalled()).toEqual(["9.9.9"]);
});

test("downloader rejects a checksum mismatch and leaves no binary", async () => {
  const { cc } = store();
  const { fetchFn } = fakeFetch({ "/claude": () => new Response("tampered bytes") });
  const dest = cc.installDirFor("9.9.9");
  await expect(officialDownloader(fetchFn, "linux-x64")("9.9.9", dest, okRunner)).rejects.toThrow(/checksum/);
  expect(cc.listInstalled()).toEqual([]);
});

test("unpublished version (404 manifest) is a clean error", async () => {
  const { cc } = store();
  const { fetchFn } = fakeFetch({ "/manifest.json": () => new Response("nope", { status: 404 }) });
  await expect(officialDownloader(fetchFn, "linux-x64")("2.1.230", cc.installDirFor("2.1.230"), okRunner))
    .rejects.toThrow(/404/);
});

test("missing platform entry in manifest is a clean error", async () => {
  const { cc } = store();
  const dl = officialDownloader(fakeFetch().fetchFn, "linux-arm64-musl");
  await expect(dl("9.9.9", cc.installDirFor("9.9.9"), okRunner)).rejects.toThrow(/linux-arm64-musl/);
});

test("downloader surfaces a binary that cannot report a version", async () => {
  const { cc } = store();
  const badRunner: CommandRunner = async () => ({ code: 1, out: "segfault" });
  await expect(officialDownloader(fakeFetch().fetchFn, "linux-x64")("9.9.9", cc.installDirFor("9.9.9"), badRunner))
    .rejects.toThrow(/--version/);
});

test("resolveLatest helper returns the trimmed version string", async () => {
  const { resolveLatestVersion } = await import("../../src/cc/install");
  expect(await resolveLatestVersion(fakeFetch().fetchFn)).toBe("9.9.9");
});

test("defaultRun merges stdout+stderr and reports exit code", async () => {
  const r = await defaultRun(["sh", "-c", "echo out; echo err >&2; exit 3"]);
  expect(r.code).toBe(3);
  expect(r.out).toContain("out");
  expect(r.out).toContain("err");
});
