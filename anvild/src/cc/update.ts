/**
 * Smoke-gated CC update orchestrator (design §4.8): download a pinned version into the
 * store, smoke it, and only then flip `current`. Phase transitions are persisted to a
 * single state file so /api/cc/v1/status can be polled from any device (design delta 4 —
 * poll, no push). The daemon process is the ONLY writer of the state file and the install
 * tree (update-state.ts lesson: file atomicity is not cross-process coordination).
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeFileAtomic } from "../util/atomic";
import { CcInstalls, binaryPath, type CcDownloader } from "./install";
import { smokeTest } from "./smoke";

/** Frozen REST contract version for /api/cc/v1 (additive-only; breaking ⇒ /v2). */
export const CC_API_VERSION = 1;

export type CcUpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "smoking"
  | "flipping"
  | "healthy"
  | "rolled-back"
  | "error";

export interface CcUpdateState {
  phase: CcUpdatePhase;
  target?: string;
  from?: string;
  reason?: string;
  updatedAt: string;
}

export interface CcUpdaterDeps {
  installs: CcInstalls;
  download: CcDownloader;
  smoke: typeof smokeTest;
  resolveLatest: () => Promise<string>;
  /** <stateDir>/cc-update-state.json — this daemon process is the only writer. */
  stateFile: string;
  /** Working dir for the smoke turn (a scratch dir; defaults to the OS tmpdir). */
  smokeCwd?: string;
  now?: () => Date;
}

export class CcUpdater {
  private state: CcUpdateState;
  // In-flight coalescing (update-api.ts [BE2-28] precedent): every concurrent apply gets
  // the same promise, so two devices tapping Update can never race two downloads.
  private inFlight: Promise<CcUpdateState> | null = null;

  constructor(private readonly deps: CcUpdaterDeps) {
    this.state = this.readState();
  }

  status(): CcUpdateState & { current?: string; previous?: string; installed: string[] } {
    return {
      ...this.state,
      current: this.deps.installs.currentVersion(),
      previous: this.deps.installs.previousVersion(),
      installed: this.deps.installs.listInstalled(),
    };
  }

  async check(): Promise<{ current?: string; latest: string; updateAvailable: boolean }> {
    const latest = await this.deps.resolveLatest();
    const current = this.deps.installs.currentVersion();
    return { current, latest, updateAvailable: latest !== current };
  }

  apply(target?: string): Promise<CcUpdateState> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.applyInner(target).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  rollback(): CcUpdateState {
    const from = this.deps.installs.currentVersion();
    const target = this.deps.installs.rollback();
    return this.setPhase("rolled-back", { target, from });
  }

  private async applyInner(target?: string): Promise<CcUpdateState> {
    const from = this.deps.installs.currentVersion();
    try {
      this.setPhase("checking", { from });
      const version = target ?? (await this.deps.resolveLatest());
      if (version === from) return this.setPhase("healthy", { target: version, from });

      this.setPhase("downloading", { target: version, from });
      const dest = this.deps.installs.installDirFor(version);
      await this.deps.download(version, dest);

      this.setPhase("smoking", { target: version, from });
      const smoke = await this.deps.smoke(binaryPath(dest), { cwd: this.deps.smokeCwd ?? tmpdir() });
      if (!smoke.ok) {
        // `current` untouched; the downloaded dir is deliberately retained for diagnosis.
        return this.setPhase("error", { target: version, from, reason: `smoke failed: ${smoke.reason ?? "unknown"}` });
      }

      this.setPhase("flipping", { target: version, from });
      this.deps.installs.activate(version);
      return this.setPhase("healthy", { target: version, from });
    } catch (e) {
      return this.setPhase("error", { target, from, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  private setPhase(phase: CcUpdatePhase, fields: Omit<Partial<CcUpdateState>, "phase" | "updatedAt"> = {}): CcUpdateState {
    const updatedAt = (this.deps.now?.() ?? new Date()).toISOString();
    // Rebuild rather than spread the old state: a stale `reason` must not outlive its phase.
    this.state = { phase, updatedAt, ...fields };
    writeFileAtomic(this.deps.stateFile, JSON.stringify(this.state, null, 2));
    return this.state;
  }

  private readState(): CcUpdateState {
    try {
      const parsed = JSON.parse(readFileSync(this.deps.stateFile, "utf8")) as CcUpdateState;
      if (typeof parsed?.phase === "string") return parsed;
    } catch {
      // missing or corrupt (torn write, hand-edit) — never fatal on boot
    }
    return { phase: "idle", updatedAt: (this.deps.now?.() ?? new Date()).toISOString() };
  }
}
