/**
 * Post-download gate (design §4.8): a candidate binary must (1) report a semver from
 * --version and (2) complete one trivial -p turn whose stream parses to init+result.
 * Auth-required by design: an unauthenticated machine cannot vouch for an update, so
 * the gate fails closed with a distinguishable reason (the CLI's own error in the log).
 */
import { defaultRun, type CommandRunner } from "./install";
import { parseCCLine } from "./stream";

export interface SmokeOutcome {
  ok: boolean;
  version?: string;
  reason?: string;
  log: string[];
}

export async function smokeTest(
  binary: string,
  opts: { cwd: string; run?: CommandRunner; timeoutMs?: number },
): Promise<SmokeOutcome> {
  const run = opts.run ?? defaultRun;
  const log: string[] = [];
  const fail = (reason: string): SmokeOutcome => ({ ok: false, reason, log });
  try {
    const ver = await run([binary, "--version"], { cwd: opts.cwd });
    log.push(`--version (exit ${ver.code}): ${ver.out.slice(0, 200)}`);
    const semver = /(\d+\.\d+\.\d+\S*)/.exec(ver.out)?.[1];
    if (ver.code !== 0 || !semver) return fail(`--version did not yield a semver (exit ${ver.code})`);

    // One trivial turn, in the daemon's session shape (settingSources: [] — no host hooks/
    // plugins, so `init` is genuinely the first stream line even on configured machines).
    const turn = await run(
      [
        binary,
        "-p", "Reply with exactly: ok",
        "--output-format", "stream-json",
        "--verbose",
        "--model", "haiku",
        "--permission-mode", "bypassPermissions",
        "--setting-sources", "",
        "--strict-mcp-config",
      ],
      { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 120_000 },
    );
    if (turn.code !== 0) {
      log.push(`turn exit ${turn.code}: ${turn.out.slice(-400)}`);
      return fail(`smoke turn exited ${turn.code}`);
    }

    const msgs = [];
    for (const line of turn.out.split("\n")) {
      const { msg, warn } = parseCCLine(line);
      if (warn) return fail(warn);
      if (msg) msgs.push(msg);
    }
    const first = msgs[0] as { type?: string; subtype?: string } | undefined;
    if (first?.type !== "system" || first?.subtype !== "init") return fail("stream did not open with system/init");
    const last = msgs[msgs.length - 1] as { type?: string; is_error?: boolean; result?: string } | undefined;
    if (last?.type !== "result") return fail("stream did not end with a result message");
    if (last.is_error) return fail(`result is_error: ${String(last.result).slice(0, 200)}`);
    log.push(`turn ok (${msgs.length} messages)`);
    return { ok: true, version: semver, log };
  } catch (e) {
    return fail(`smoke crashed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
