/**
 * Fake Claude Code CLI for turn-runner tests (plan 3 task 1). A REAL spawned bun script —
 * the repo never mocks node:child_process — that speaks just enough of the CLI's contract:
 * reads stdin to EOF (the runner writes one stream-json user message per turn), then replays
 * a golden .ndjson fixture to stdout. Configured entirely by env:
 *
 *   FAKE_CC_FIXTURE       path to the .ndjson to replay (default: ../fixtures/cc/basic.ndjson)
 *   FAKE_CC_DELAY_MS      pacing between lines (default 0)
 *   FAKE_CC_EXIT_CODE     exit code after the replay (default 0)
 *   FAKE_CC_ERROR         print this to stderr and exit 1 immediately (resume-rejection tests)
 *   FAKE_CC_HANG_AFTER    emit N lines, then hang until signalled (interrupt-mid-stream tests)
 *   FAKE_CC_IGNORE_SIGINT "1": ignore SIGINT (exercises the grace→SIGKILL escalation)
 *   FAKE_CC_TRUNCATE_LAST "1": cut the final line mid-way, no newline (crash-mid-line tests)
 *   FAKE_CC_ARGS_FILE     write JSON argv (after the script path) here at startup
 *   FAKE_CC_STDIN_FILE    write the full stdin text here before replaying
 *
 * Default SIGINT behavior mirrors the real CLI: exit 130 promptly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const args = process.argv.slice(2);

if (env.FAKE_CC_ARGS_FILE) writeFileSync(env.FAKE_CC_ARGS_FILE, JSON.stringify(args));

if (env.FAKE_CC_IGNORE_SIGINT === "1") {
  process.on("SIGINT", () => {});
} else {
  process.on("SIGINT", () => process.exit(130));
}

if (env.FAKE_CC_ERROR) {
  process.stderr.write(`${env.FAKE_CC_ERROR}\n`);
  process.exit(1);
}

// The runner writes the turn's user message then closes stdin — consume it all first, like
// the real -p flow, so tests can assert exactly what was written.
let stdinText = "";
for await (const chunk of process.stdin) stdinText += Buffer.from(chunk).toString("utf8");
if (env.FAKE_CC_STDIN_FILE) writeFileSync(env.FAKE_CC_STDIN_FILE, stdinText);

const fixture = env.FAKE_CC_FIXTURE ?? join(import.meta.dir, "..", "fixtures", "cc", "basic.ndjson");
const lines = readFileSync(fixture, "utf8").split("\n").filter((l) => l.trim().length > 0);
const delayMs = Number(env.FAKE_CC_DELAY_MS ?? 0);
const hangAfter = env.FAKE_CC_HANG_AFTER ? Number(env.FAKE_CC_HANG_AFTER) : undefined;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

for (let i = 0; i < lines.length; i++) {
  if (hangAfter !== undefined && i >= hangAfter) {
    await new Promise(() => {}); // hang until a signal ends us
  }
  const last = i === lines.length - 1;
  if (last && env.FAKE_CC_TRUNCATE_LAST === "1") {
    process.stdout.write(lines[i]!.slice(0, Math.floor(lines[i]!.length / 2))); // torn line, no \n
    break;
  }
  process.stdout.write(`${lines[i]}\n`);
  if (delayMs > 0) await delay(delayMs);
}

process.exit(Number(env.FAKE_CC_EXIT_CODE ?? 0));
