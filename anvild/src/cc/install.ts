/**
 * Versioned Claude Code installs (design §4.8): <root>/versions/<v>/ holds one complete
 * install; <root>/current and <root>/previous are symlinks. Flips are atomic via the
 * repo's established pattern (web/build.ts): create `<name>.next`, then rename(2) over
 * `<name>`. NET-NEW store — the daemon self-updater is git-in-place and shares no code.
 * Single-writer: only the daemon process mutates this tree (update-state.ts lesson —
 * writeFileAtomic-style atomicity does not give cross-process read-modify-write).
 */
import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
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
