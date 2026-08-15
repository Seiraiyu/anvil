// Phase-6 acceptance, offline form (cc plan 6 Task 5, design §5.6): kill the daemon mid-turn →
// restart → the event log heals from the transcript; and a turn taken in the attached PTY
// appears in every client's history after detach. The transcript is the REAL golden recording
// (test/fixtures/cc-transcript); the "daemon" is a real Supervisor over a temp state dir with
// CLAUDE_CONFIG_DIR pointed at a temp CC config root.
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ServerEvent } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import { reconcileTranscript } from "../../src/cc/reconcile";
import { projectSlug } from "../../src/cc/transcript";
import { PassthroughRenderer } from "../../src/render/markdown";
import type { SessionEventBody } from "../../src/session/session";
import type { SpawnTerminal } from "../../src/session/terminal-manager";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "cc-transcript");
const meta = require(join(FIXTURES, "meta.json"));
const renderer = new PassthroughRenderer();

const PROMPT_A = "Use the Read tool to read note.txt, then reply with the magic word only.";
const PROMPT_B = "Reply with exactly: resumed-ok";
const PROMPT_PTY = `Reply with exactly: ${meta.ptyMarker}`;

/** What a fully-live CLI turn would have logged: the fixture mapped with ccUuid stamps. */
function liveBodies(): SessionEventBody[] {
  const out: SessionEventBody[] = [];
  reconcileTranscript(join(FIXTURES, "transcript.jsonl"), { renderer, events: () => [], emit: (b) => out.push(b) });
  return out;
}

/** Plant the golden transcript where the daemon will look for it: <cfg>/projects/<slug(cwd)>/<sid>.jsonl */
function plantTranscript(cfgDir: string, cwd: string): void {
  const dir = join(cfgDir, "projects", projectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIXTURES, "transcript.jsonl"), join(dir, `${meta.sessionId}.jsonl`));
}

const userSources = (events: ServerEvent[]) =>
  events.filter((e) => e.type === "message.user").map((e) => (e as { rendered: { source: string } }).rendered.source);

test("kill -9 mid-turn → restart → the event log heals from the transcript", async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), "anvil-cc-cfg-"));
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-cc-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "anvil-cc-work-"));
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  try {
    const sup1 = new Supervisor({ stateDir, envFile: join(stateDir, "env") }, new ConnectionRegistry());
    const created = await sup1.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: workDir });
    const s1 = sup1.get(created.id)!;
    s1.data.claudeSessionId = meta.sessionId;
    plantTranscript(cfgDir, workDir);

    // The turn up to the crash: the daemon logged the prompt and streamed as far as the
    // tool_use — then the process died. Nothing after the tool_use ever reached the log.
    s1.emit({ type: "message.user", rendered: renderer.render(PROMPT_A), attachments: [] });
    const live = liveBodies();
    const toolUse = live.find((b) => b.type === "tool.use") as { ccUuid?: string };
    for (const b of live.filter((b) => (b as { ccUuid?: string }).ccUuid === toolUse.ccUuid)) s1.emit(b);
    const seqAtCrash = s1.lastSeq;
    await new Promise((r) => setTimeout(r, 150)); // sessions.json is debounce-flushed (100ms)

    // ── kill -9: no shutdown, no flush of anything else — just a fresh process over the state ──
    const sup2 = new Supervisor({ stateDir, envFile: join(stateDir, "env") }, new ConnectionRegistry());
    const healed = sup2.resume(created.id, 0);

    // the missing tail arrived: tool result, both later turns' prompts + replies — no duplicates
    expect(userSources(healed)).toEqual([PROMPT_A, PROMPT_B, PROMPT_PTY]);
    expect(healed.filter((e) => e.type === "tool.use").length).toBe(1);
    expect(healed.filter((e) => e.type === "tool.result").length).toBe(1);
    const assistantJson = JSON.stringify(healed.filter((e) => e.type === "assistant.message"));
    expect(assistantJson).toContain("resumed-ok");
    expect(assistantJson).toContain(meta.ptyMarker);
    // backfills are NEW events (fresh seq after the crash watermark) — catch-up replay by seq works
    const backfills = sup2.resume(created.id, seqAtCrash).filter((e) => e.type !== "status");
    expect(backfills.length).toBeGreaterThan(0);
    expect(backfills.every((e) => (e as { seq: number }).seq > seqAtCrash)).toBe(true);
    // and a second restart backfills nothing more (idempotent by ccUuid)
    const sup3 = new Supervisor({ stateDir, envFile: join(stateDir, "env") }, new ConnectionRegistry());
    expect(sup3.get(created.id)!.lastSeq).toBe(sup2.get(created.id)!.lastSeq);
  } finally {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    for (const d of [cfgDir, stateDir, workDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("a turn taken in the attached PTY appears in history after detach", async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), "anvil-cc-cfg-"));
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-cc-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "anvil-cc-work-"));
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  const spawnTerminal: SpawnTerminal = () => ({
    pty: { resize() {}, write() {}, close() {} },
    proc: { exited: new Promise<number | null>(() => {}) },
  });
  try {
    const sup = new Supervisor({ stateDir, envFile: join(stateDir, "env"), spawnTerminal }, new ConnectionRegistry());
    const created = await sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: workDir });
    const s = sup.get(created.id)!;
    s.data.claudeSessionId = meta.sessionId;
    plantTranscript(cfgDir, workDir);

    // Both headless turns were fully live-logged before the attach (prompts + stamped events).
    s.emit({ type: "message.user", rendered: renderer.render(PROMPT_A), attachments: [] });
    s.emit({ type: "message.user", rendered: renderer.render(PROMPT_B), attachments: [] });
    for (const b of liveBodies().filter((b) => b.type !== "message.user" && !JSON.stringify(b).includes(meta.ptyMarker))) s.emit(b);

    sup.ccAttach(created.id, 80, 24);
    expect(s.data.attached).toBe(true);
    const seqAtAttach = s.lastSeq;

    // (the PTY turn is already in the planted transcript — the user typed it in the terminal)
    sup.ccDetach(created.id);
    expect(s.data.attached).toBe(false);
    expect(s.data.status).toBe("idle");

    // exactly the PTY turn arrived, as fresh-seq events every client replays by watermark
    const delta = sup.resume(created.id, seqAtAttach).filter((e) => e.type !== "status");
    expect(userSources(delta)).toEqual([PROMPT_PTY]);
    expect(JSON.stringify(delta.filter((e) => e.type === "assistant.message"))).toContain(meta.ptyMarker);
    expect(delta.every((e) => (e as { seq: number }).seq > seqAtAttach)).toBe(true);
    // and a re-attach → detach round trip finds nothing new (idempotent)
    sup.ccAttach(created.id, 80, 24);
    sup.ccDetach(created.id);
    expect(userSources(sup.resume(created.id, 0))).toEqual([PROMPT_A, PROMPT_B, PROMPT_PTY]);
  } finally {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    for (const d of [cfgDir, stateDir, workDir]) rmSync(d, { recursive: true, force: true });
  }
});
