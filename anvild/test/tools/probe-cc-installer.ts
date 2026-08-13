/**
 * LIVE probe: bun test/tools/probe-cc-installer.ts [version]
 *
 * Resolves design Assumption 4 (can we place a PINNED version in a CALLER-CHOSEN dir?).
 *
 * ── VERIFIED FINDINGS (2026-08-13, script fetched from https://claude.ai/install.sh) ──
 * The official install.sh accepts `[stable|latest|X.Y.Z]` as $1, but only to pass it to
 * `"$binary" install [target]` — and `claude install` has NO directory flag (help output:
 * only --force). Directory control via the script would require redirecting $HOME.
 *
 * BUT the script reveals a stable direct-download contract, which is what it itself uses:
 *   BASE = https://downloads.claude.ai/claude-code-releases
 *   GET BASE/latest                          → version string (e.g. "2.1.231")
 *   GET BASE/<version>/manifest.json         → { platforms: { "<platform>": { checksum } } }
 *   GET BASE/<version>/<platform>/claude     → the single self-contained binary
 *   platform = {linux,darwin}-{x64,arm64}[-musl]  (musl when ldd /bin/ls mentions musl)
 *   verify sha256 == manifest checksum, chmod 755 — done. `claude install` is only for
 *   launcher/shell integration, which the daemon does not want.
 *
 * ⇒ Task 4's officialDownloader uses the DIRECT DOWNLOAD contract (pinned version, any
 *   destination dir, checksum-verified), not the install.sh/`claude install` path.
 *   resolveLatest() = GET BASE/latest. GET BASE/stable also exists (a lagging channel:
 *   latest was 2.1.231 while stable said 2.1.223).
 *
 * Verified live 2026-08-13 on linux-x64: latest (2.1.231) and pinned 2.1.229 both
 * download, checksum-match, and run --version from a temp dir. NOTE not every patch
 * number is published — 2.1.230/manifest.json is a 404 — so pinned targets must come
 * from `latest`/`stable` or a previously-seen version, and 404s need a clean error.
 *
 * This probe re-verifies that contract end to end: resolve version (argv[2] or latest),
 * fetch manifest, download the binary into a temp dir, check the sha256, run --version.
 */
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "https://downloads.claude.ai/claude-code-releases";

function detectPlatform(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (os === "linux") {
    const ldd = Bun.spawnSync(["ldd", "/bin/ls"]);
    const txt = new TextDecoder().decode(ldd.stdout) + new TextDecoder().decode(ldd.stderr);
    if (txt.includes("musl")) return `linux-${arch}-musl`;
  }
  return `${os}-${arch}`;
}

async function text(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.text()).trim();
}

const version = process.argv[2] ?? (await text(`${BASE}/latest`));
if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`bad version: ${version}`);
const platform = detectPlatform();
console.log(`version=${version} platform=${platform}`);

const manifest = JSON.parse(await text(`${BASE}/${version}/manifest.json`));
const expected = manifest.platforms?.[platform]?.checksum;
console.log(`manifest checksum for ${platform}: ${expected}`);
if (!expected) throw new Error(`no manifest entry for ${platform}`);

const dest = mkdtempSync(join(tmpdir(), "anvil-cc-probe-"));
const res = await fetch(`${BASE}/${version}/${platform}/claude`);
if (!res.ok) throw new Error(`binary download → ${res.status}`);
const buf = new Uint8Array(await res.arrayBuffer());
const actual = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
console.log(`downloaded ${buf.length} bytes, sha256 ${actual === expected ? "MATCHES" : `MISMATCH (${actual})`}`);
if (actual !== expected) throw new Error("checksum mismatch");

const bin = join(dest, "claude");
writeFileSync(bin, buf);
chmodSync(bin, 0o755);
const proc = Bun.spawnSync([bin, "--version"]);
console.log(`${bin} --version → ${new TextDecoder().decode(proc.stdout).trim()} (exit ${proc.exitCode})`);
