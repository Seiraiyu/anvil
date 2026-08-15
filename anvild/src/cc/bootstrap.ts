/**
 * First-run CC bootstrap (design §4.8: "The daemon refuses to start sessions only when *no*
 * healthy install exists — first-run bootstrap downloads one"; §5.9 acceptance: a fresh
 * `service.sh install` on Linux and macOS reaches a working session).
 *
 * Plan 2 shipped the store, the smoke gate and the update orchestrator, but bootstrap was only
 * ever a *user-initiated* `apply()` from the settings card. On a machine with no managed install
 * AND no `claude` on PATH the first turn therefore died with a raw ENOENT from `spawnInGroup`.
 * This module closes that: the turn paths ask for a spawnable CC and get one, downloading the
 * latest through the existing smoke-gated `CcUpdater.apply()` if that's what it takes.
 *
 * Registered as a process singleton, and that is by construction rather than convenience: the
 * state it guards IS process-global — `process.env.ANVIL_CLI_PATH` (the plan-2 bridge) and the
 * install tree under `ccDir`, which `update.ts` documents as single-writer-per-daemon-process.
 * Threading an updater through supervisor → turn-runner → oneshot → autopilot → pipeline to
 * reach that one instance would be ceremony around a fact. Unregistered (unit tests, one-off
 * tooling) it is a no-op, so nothing downloads a CLI behind a test's back.
 */
import { existsSync } from "node:fs";
import { CcInstalls, bridgeCliPath } from "./install";

/** Thrown when no CC could be made spawnable. Distinct type so `failTurn`'s resume-rejected
 *  heuristic (which matches on "unauthorized"/"forbidden") can't misread a CDN error string
 *  as a dead conversation and silently drop the session's `claudeSessionId`. */
export class CcBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CcBootstrapError";
  }
}

export interface CcBootstrapDeps {
  installs: CcInstalls;
  /** The daemon's single `CcUpdater.apply` — reused so bootstrap gets the same download +
   *  smoke gate + atomic flip + pollable phase state as any other update. */
  apply: () => Promise<{ phase: string; reason?: string }>;
  /** The env the ANVIL_CLI_PATH bridge writes to (the real daemon passes `process.env`). */
  env: Record<string, string | undefined>;
  /** PATH lookup; injectable so tests never depend on the host having a `claude`. */
  onPath?: (cmd: string) => string | null;
  log?: (message: string) => void;
}

export class CcBootstrap {
  /** Latched once a CC is known spawnable: the steady-state cost is one boolean per turn. */
  private ready = false;
  /** Single-flight, so a burst of concurrent turns on a fresh machine bootstraps once. */
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: CcBootstrapDeps) {}

  /** Resolve once a CC binary is spawnable; reject with `CcBootstrapError` if none can be. */
  ensure(): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    // An explicit override is the operator's word, and a wrong one must not be papered over by a
    // download the bridge would then refuse to adopt (bridgeCliPath never overwrites a set value).
    const explicit = this.deps.env.ANVIL_CLI_PATH?.trim();
    if (explicit) {
      if (existsSync(explicit)) {
        this.ready = true;
        return;
      }
      throw new CcBootstrapError(`ANVIL_CLI_PATH points at a missing binary: ${explicit}`);
    }

    if (this.spawnable()) {
      this.ready = true;
      return;
    }

    this.log("no Claude Code found (no managed install, none on PATH) — bootstrapping the latest…");
    const state = await this.deps.apply();
    // Adopt whatever apply() just activated; a no-op if it activated nothing.
    bridgeCliPath(this.deps.installs, this.deps.env);
    if (!this.spawnable()) {
      const why = state.reason ? `${state.phase}: ${state.reason}` : state.phase;
      throw new CcBootstrapError(
        `could not install Claude Code (${why}). Install it manually, or use Settings → Claude Code on any device.`,
      );
    }
    this.ready = true;
    this.log(`bootstrapped Claude Code ${this.deps.installs.currentVersion() ?? "(unknown version)"}`);
  }

  /** Is there a CC the turn paths can spawn? Bridges a managed `current` into env on the way. */
  private spawnable(): boolean {
    bridgeCliPath(this.deps.installs, this.deps.env);
    if (this.deps.env.ANVIL_CLI_PATH) return true;
    const which = this.deps.onPath ?? ((cmd: string) => Bun.which(cmd));
    return !!which("claude");
  }

  private log(message: string): void {
    (this.deps.log ?? ((m: string) => console.log(`[cc] ${m}`)))(message);
  }
}

let registered: CcBootstrap | null = null;

/** Install the daemon's bootstrapper (real daemon boot only). Pass `null` to clear. */
export function registerCcBootstrap(bootstrap: CcBootstrap | null): void {
  registered = bootstrap;
}

/** Await a spawnable CC. No-op when unregistered, so unit tests and one-off tooling that
 *  already point `ccCommand` at a fake never touch the network. */
export function ensureCcAvailable(): Promise<void> {
  return registered ? registered.ensure() : Promise.resolve();
}
