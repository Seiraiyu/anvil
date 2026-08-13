/**
 * Versioned Claude Code installs (design §4.8): <root>/versions/<v>/ holds one complete
 * install; <root>/current and <root>/previous are symlinks. Flips are atomic via the
 * repo's established pattern (web/build.ts): create `<name>.next`, then rename(2) over
 * `<name>`. NET-NEW store — the daemon self-updater is git-in-place and shares no code.
 * Single-writer: only the daemon process mutates this tree (update-state.ts lesson —
 * writeFileAtomic-style atomicity does not give cross-process read-modify-write).
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export function binaryPath(installDir: string): string {
  return join(installDir, "bin", "claude");
}

export class CcInstalls {
  constructor(private readonly root: string) {
    mkdirSync(join(root, "versions"), { recursive: true });
  }

  installDirFor(version: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(version)) throw new Error(`bad version string: ${version}`);
    return join(this.root, "versions", version);
  }

  listInstalled(): string[] {
    return readdirSync(join(this.root, "versions")).filter((v) => existsSync(binaryPath(this.installDirFor(v)))).sort();
  }

  currentVersion(): string | undefined { return this.linkedVersion("current"); }
  previousVersion(): string | undefined { return this.linkedVersion("previous"); }

  /** Absolute path of the active binary, or undefined when nothing is activated yet. */
  currentBinary(): string | undefined {
    const v = this.currentVersion();
    return v ? binaryPath(this.installDirFor(v)) : undefined;
  }

  /** Point `current` at `version` (must have a binary); the old current becomes `previous`. */
  activate(version: string): void {
    const target = this.installDirFor(version);
    if (!existsSync(binaryPath(target))) throw new Error(`not installed: ${version}`);
    const cur = this.currentVersion();
    if (cur && cur !== version) this.flip("previous", this.installDirFor(cur));
    this.flip("current", target);
  }

  /** Swap current↔previous. Returns the version now current. */
  rollback(): string {
    const prev = this.previousVersion();
    if (!prev) throw new Error("no previous version to roll back to");
    this.activate(prev);
    return prev;
  }

  /** Delete an inactive version dir (never current/previous). */
  remove(version: string): void {
    if (version === this.currentVersion() || version === this.previousVersion()) {
      throw new Error(`refusing to remove active version: ${version}`);
    }
    rmSync(this.installDirFor(version), { recursive: true, force: true });
  }

  private linkedVersion(name: string): string | undefined {
    try { return basename(readlinkSync(join(this.root, name))); } catch { return undefined; }
  }

  private flip(name: string, target: string): void {
    const next = join(this.root, `${name}.next`);
    rmSync(next, { force: true });
    symlinkSync(target, next);
    renameSync(next, join(this.root, name)); // atomic on POSIX — in-flight turns keep their open binary
  }
}

/**
 * Make the managed install the daemon's CLI even before Plan 3, via the seam that already
 * exists: agent/cli.ts reads ANVIL_CLI_PATH. An explicit pre-set value (operator override,
 * packaged-app bundle path) always wins; no activated install ⇒ no-op (SDK default).
 */
export function bridgeCliPath(installs: CcInstalls, env: Record<string, string | undefined>): void {
  const bin = installs.currentBinary();
  if (bin && !env.ANVIL_CLI_PATH) env.ANVIL_CLI_PATH = bin;
}

// ── Downloader ──────────────────────────────────────────────────────────────────────────
// Contract verified live by test/tools/probe-cc-installer.ts (2026-08-13): the official
// install.sh has no directory control, but the release bucket it reads from does exactly
// what we need — pinned version, any destination, sha256 from the per-version manifest.
// Not every patch number is published (2.1.230 → 404), so unknown targets must fail clean.

const DOWNLOAD_BASE = "https://downloads.claude.ai/claude-code-releases";

export type CommandRunner = (
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<{ code: number; out: string }>;

/** Bun.spawn with merged stdout+stderr — the shape of selfupdate.ts's runner, cc-flavored. */
export const defaultRun: CommandRunner = async (cmd, opts = {}) => {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // A hung child exits nonzero via SIGTERM instead of wedging the caller forever.
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: `${stdout}${stderr}`.trim() };
};

/** The release bucket's platform key for this host ({linux,darwin}-{x64,arm64}[-musl]). */
export function ccPlatform(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (os === "linux") {
    try {
      const ldd = Bun.spawnSync(["ldd", "/bin/ls"]);
      const txt = new TextDecoder().decode(ldd.stdout) + new TextDecoder().decode(ldd.stderr);
      if (txt.includes("musl")) return `linux-${arch}-musl`;
    } catch {
      // no ldd (odd minimal image) → assume glibc, same as the official installer's fallback
    }
  }
  return `${os}-${arch}`;
}

/** GET <bucket>/latest → the newest published version string. */
export async function resolveLatestVersion(fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(`${DOWNLOAD_BASE}/latest`);
  if (!res.ok) throw new Error(`resolve latest CC version: HTTP ${res.status}`);
  const version = (await res.text()).trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected content from /latest: ${version.slice(0, 80)}`);
  return version;
}

export type CcDownloader = (version: string, destDir: string, run?: CommandRunner) => Promise<{ version: string }>;

/**
 * Downloads a pinned CC version into destDir via the verified direct-download contract:
 * manifest checksum → binary → sha256 verify → chmod → `--version` sanity. The binary
 * lands at binaryPath(destDir); nothing is left behind on any failure path before that.
 */
export function officialDownloader(fetchFn: typeof fetch = fetch, platform: string = ccPlatform()): CcDownloader {
  return async (version, destDir, run = defaultRun) => {
    const manifestRes = await fetchFn(`${DOWNLOAD_BASE}/${version}/manifest.json`);
    if (!manifestRes.ok) {
      throw new Error(`no manifest for CC ${version} (HTTP ${manifestRes.status}) — not every patch version is published`);
    }
    const manifest = (await manifestRes.json()) as { platforms?: Record<string, { checksum?: string }> };
    const expected = manifest.platforms?.[platform]?.checksum;
    if (!expected) throw new Error(`CC ${version} manifest has no entry for platform ${platform}`);

    const binRes = await fetchFn(`${DOWNLOAD_BASE}/${version}/${platform}/claude`);
    if (!binRes.ok) throw new Error(`download CC ${version} binary: HTTP ${binRes.status}`);
    const bytes = new Uint8Array(await binRes.arrayBuffer());
    const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`checksum mismatch for CC ${version}: expected ${expected}, got ${actual}`);

    const bin = binaryPath(destDir);
    mkdirSync(join(destDir, "bin"), { recursive: true });
    writeFileSync(`${bin}.part`, bytes);
    chmodSync(`${bin}.part`, 0o755);
    renameSync(`${bin}.part`, bin); // a torn download can never sit at the binary path

    const probe = await run([bin, "--version"]);
    if (probe.code !== 0) throw new Error(`downloaded CC binary failed --version (exit ${probe.code}): ${probe.out.slice(-400)}`);
    const m = /(\d+\.\d+\.\d+\S*)/.exec(probe.out);
    if (!m) throw new Error(`downloaded CC binary --version output unrecognizable: ${probe.out.slice(0, 120)}`);
    return { version: m[1]! };
  };
}
