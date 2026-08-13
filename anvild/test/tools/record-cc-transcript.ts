/**
 * Records the transcript-JSONL golden fixture from the REAL claude CLI (cc plan 6 Task 1 —
 * the on-disk `~/.claude/projects/<slug>/<id>.jsonl` shapes are a DIFFERENT format from the
 * stream-json stdout and are pinned by their own fixture before the reconciler is coded).
 * Sibling of record-cc-stream.ts (Plan 1); requires an authenticated `claude` on PATH.
 *
 *   bun test/tools/record-cc-transcript.ts [claude-binary]
 *
 * Writes test/fixtures/cc-transcript/{turn-a.ndjson,turn-b.ndjson,transcript-after-a.jsonl,
 * transcript.jsonl,meta.json}. Scenarios, all in one CC session (one transcript file):
 *   A — headless tool turn, stdin stream-json (the turn-runner's exact input mode)
 *   B — headless `--resume` turn (pins: resume APPENDS to the same transcript file)
 *   C — interactive TUI `--resume` turn driven through a real PTY (Bun.Terminal) — the
 *       attach flow's transcript shape (pins: TUI resume keeps the same file too, plus the
 *       TUI-only line types a reconciler must skip)
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userMessage } from "../../src/agent/attachments";
import { claudeConfigDir, projectSlug, readTranscript, isMessageLine } from "../../src/cc/transcript";
import { cttyArgv } from "../../src/session/terminal-manager";

const bin = process.argv[2] ?? "claude";
const outDir = join(import.meta.dir, "..", "fixtures", "cc-transcript");
mkdirSync(outDir, { recursive: true });

const MAGIC = "xylophone";
const PTY_MARKER = "pty-marker-xyzzy";
const cwd = mkdtempSync(join(tmpdir(), "anvil-cc-transcript-"));
writeFileSync(join(cwd, "note.txt"), `the magic word is ${MAGIC}\n`);

// Recording may itself run inside a Claude Code session; the inherited child-session marker
// makes the interactive TUI SKIP transcript persistence ("Transcript saving is off"), which
// would break the whole fixture. Strip it for every spawned CC.
const env: Record<string, string> = { ...(process.env as Record<string, string>) };
delete env.CLAUDE_CODE_CHILD_SESSION;

// Match the plan-1 recorder: no user setting sources, so the fixture pins CC's OWN transcript
// shapes (not the recording user's hooks/plugins) and stays stable across machines.
const HERMETIC = ["--model", "haiku", "--setting-sources", "", "--strict-mcp-config"];
const HEADLESS = [
  "-p",
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--permission-mode", "bypassPermissions",
  ...HERMETIC,
];

async function headlessTurn(prompt: string, resume?: string): Promise<string> {
  const args = [...HEADLESS, ...(resume ? ["--resume", resume] : [])];
  const proc = Bun.spawn([bin, ...args], {
    cwd,
    stdin: new Response(`${JSON.stringify(userMessage(prompt))}\n`),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${bin} ${args.join(" ")} exited ${code}\n${err}`);
  return out;
}

function initSessionId(ndjson: string): string {
  for (const line of ndjson.split("\n")) {
    try {
      const m = JSON.parse(line);
      if (m?.type === "system" && m?.subtype === "init" && typeof m.session_id === "string") return m.session_id;
    } catch {
      /* skip partials */
    }
  }
  throw new Error("no system/init session_id in recording");
}

const version = (await new Response(Bun.spawn([bin, "--version"], { stdout: "pipe" }).stdout).text()).trim();

// ── Turn A: headless tool turn ────────────────────────────────────────────────
const turnA = await headlessTurn("Use the Read tool to read note.txt, then reply with the magic word only.");
const sid = initSessionId(turnA);

// Locate the transcript by SEARCHING for the session id, then verify the directory name
// against the derived slug (plan 6 fixed decision: derive like CC does, verify, don't assume).
const projectsDir = join(claudeConfigDir(), "projects");
const actualSlug = readdirSync(projectsDir).find((d) => {
  try {
    return readdirSync(join(projectsDir, d)).includes(`${sid}.jsonl`);
  } catch {
    return false;
  }
});
if (!actualSlug) throw new Error(`transcript ${sid}.jsonl not found under ${projectsDir}`);
if (actualSlug !== projectSlug(cwd)) {
  throw new Error(`slug derivation mismatch: CC wrote "${actualSlug}", projectSlug(cwd) says "${projectSlug(cwd)}"`);
}
const transcriptFile = join(projectsDir, actualSlug, `${sid}.jsonl`);
const afterA = readTranscript(transcriptFile).lines.length;
cpSync(transcriptFile, join(outDir, "transcript-after-a.jsonl"));

// ── Turn B: headless --resume (same file must grow) ──────────────────────────
const turnB = await headlessTurn("Reply with exactly: resumed-ok", sid);
if (initSessionId(turnB) !== sid) throw new Error("headless --resume changed the session id");
const afterB = readTranscript(transcriptFile).lines.length;
if (afterB <= afterA) throw new Error("headless --resume did not append to the same transcript file");

// ── Turn C: interactive TUI --resume in a real PTY ────────────────────────────
const BunAny = Bun as unknown as {
  Terminal: new (o: { cols: number; rows: number; data: (t: unknown, b: Uint8Array) => void }) => {
    write(data: string | Buffer): void;
    close(): void;
  };
  spawn: (
    cmd: string[],
    o: { terminal: unknown; cwd: string; env: Record<string, string> },
  ) => { exited: Promise<number | null>; kill(): void };
};

let ptyOut = "";
const term = new BunAny.Terminal({
  cols: 120,
  rows: 30,
  data: (_t, bytes) => {
    ptyOut += Buffer.from(bytes).toString("utf8");
  },
});
// Same ctty discipline as the daemon's terminal manager — the TUI wants a controlling terminal.
const argv = cttyArgv(process.platform, bin).slice(0, -1); // wrapper prefix (setsid --ctty --wait / script …)
const ptyCmd = [...argv, bin, "--resume", sid, "--permission-mode", "default", ...HERMETIC];
const proc = BunAny.spawn(ptyCmd, {
  terminal: term,
  cwd,
  env: { ...env, TERM: "xterm-256color" },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The TUI paints with cursor positioning, so words in the captured bytes lose their spacing —
// strip ANSI *and* whitespace before matching screen text.
const screen = () => ptyOut.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\s+/g, "");

// Wait for the composer ("? for shortcuts"), answering the folder-trust gate with Enter.
const deadline = Date.now() + 60_000;
let trusted = false;
while (Date.now() < deadline) {
  await sleep(300);
  const s = screen();
  if (!trusted && /trustthisfolder|Quicksafetycheck/i.test(s)) {
    term.write("\r");
    trusted = true;
    ptyOut = "";
    continue;
  }
  if (/forshortcuts/i.test(s)) break;
}
if (!/forshortcuts/i.test(screen())) throw new Error(`TUI composer never appeared. Screen:\n${screen().slice(-2000)}`);

term.write(`Reply with exactly: ${PTY_MARKER}`);
await sleep(500);
term.write("\r");

// Completion = the transcript gained the marker user line AND a later assistant line.
// Poll the DIRECTORY too: if TUI resume forked a new session file, find (and record) it.
let ptyFile = transcriptFile;
let ptySid = sid;
const turnDeadline = Date.now() + 120_000;
let done = false;
while (Date.now() < turnDeadline && !done) {
  await sleep(1000);
  for (const f of readdirSync(join(projectsDir, actualSlug)).filter((f) => f.endsWith(".jsonl"))) {
    const lines = readTranscript(join(projectsDir, actualSlug, f)).lines;
    const msgs = lines.filter(isMessageLine);
    const idx = msgs.findIndex(
      (m) => m.type === "user" && !m.isMeta && JSON.stringify(m.message.content).includes(PTY_MARKER),
    );
    if (idx >= 0 && msgs.slice(idx + 1).some((m) => m.type === "assistant")) {
      ptyFile = join(projectsDir, actualSlug, f);
      ptySid = f.replace(/\.jsonl$/, "");
      done = true;
      break;
    }
  }
}
if (!done) throw new Error(`PTY turn never landed in a transcript. Last TUI output:\n${screen().slice(-2000)}`);

await sleep(1500);
term.write("/exit");
await sleep(400);
term.write("\r");
const exited = await Promise.race([proc.exited, sleep(15_000).then(() => "timeout" as const)]);
if (exited === "timeout") {
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
  term.close();
}

const finalCount = readTranscript(ptyFile).lines.length;
cpSync(ptyFile, join(outDir, "transcript.jsonl"));
writeFileSync(join(outDir, "turn-a.ndjson"), turnA);
writeFileSync(join(outDir, "turn-b.ndjson"), turnB);
writeFileSync(
  join(outDir, "meta.json"),
  `${JSON.stringify(
    {
      ccVersion: version,
      cwd,
      slug: actualSlug,
      sessionId: sid,
      ptySessionId: ptySid, // === sessionId ⇔ TUI resume appends to the same file (the attach-flow assumption)
      magicWord: MAGIC,
      ptyMarker: PTY_MARKER,
      lineCounts: { afterA, afterB, final: finalCount },
    },
    null,
    2,
  )}\n`,
);
console.log(`recorded to ${outDir} (cc ${version}); sid=${sid} ptySid=${ptySid} lines a/b/final=${afterA}/${afterB}/${finalCount}`);
process.exit(0);
