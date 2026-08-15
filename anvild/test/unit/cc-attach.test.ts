// PTY attach flow (cc plan 6 Task 4, design §4.9): `cc.attach` puts the session's REAL CC
// conversation in a terminal — only from idle, headless prompts blocked until detach.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CC_ATTACH_TERM_ID, PROTOCOL_VERSION } from "@protocol";
import { Supervisor, BadCommand } from "../../src/session/supervisor";
import { ConnectionRegistry } from "../../src/server/registry";
import type { SpawnTerminal } from "../../src/session/terminal-manager";

function fakeSpawn() {
  const created: Array<{
    command?: string[];
    cwd: string;
    pty: { closed: boolean };
    exit: (code: number | null) => void;
  }> = [];
  const spawn: SpawnTerminal = ({ cwd, command }) => {
    let resolveExit!: (c: number | null) => void;
    const proc = { exited: new Promise<number | null>((r) => (resolveExit = r)) };
    const pty = {
      closed: false,
      resize() {},
      write() {},
      close() {
        this.closed = true;
      },
    };
    const rec = { command, cwd, pty, exit: resolveExit };
    created.push(rec);
    return { pty, proc };
  };
  return { spawn, created };
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "anvil-cc-attach-"));
  const { spawn, created } = fakeSpawn();
  const sup = new Supervisor({ stateDir: dir, envFile: join(dir, "env"), spawnTerminal: spawn }, new ConnectionRegistry());
  const data = await sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: dir });
  return { sup, dir, created, id: data.id };
}

test("attach requires a resumable CC conversation", async () => {
  const { sup, id, dir } = await harness();
  expect(() => sup.ccAttach(id, 80, 24)).toThrow(BadCommand); // no claudeSessionId yet
  rmSync(dir, { recursive: true, force: true });
});

test("attach from idle spawns `claude --resume <id>` in the reserved PTY and flips attached", async () => {
  const { sup, id, dir, created } = await harness();
  const s = sup.get(id)!;
  s.data.claudeSessionId = "sid-123";

  sup.ccAttach(id, 100, 30);
  expect(created.length).toBe(1);
  expect(created[0]!.command!.slice(-2)).toEqual(["--resume", "sid-123"]);
  expect(created[0]!.cwd).toBe(s.data.cwd);
  expect(s.data.attached).toBe(true);
  expect(s.data.terminals).toEqual([{ id: CC_ATTACH_TERM_ID, title: "claude" }]);

  // double-attach refused; the attach PTY replays (no second spawn) via terminal.open
  expect(() => sup.ccAttach(id, 80, 24)).toThrow(/already attached/);
  sup.terminalOpen(id, 80, 24, CC_ATTACH_TERM_ID);
  expect(created.length).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("attach is refused unless the session is idle with nothing parked", async () => {
  const { sup, id, dir } = await harness();
  const s = sup.get(id)!;
  s.data.claudeSessionId = "sid-123";

  s.setStatus("thinking");
  expect(() => sup.ccAttach(id, 80, 24)).toThrow(/can't attach while/);
  s.setStatus("idle");

  s.requestPermission("req-1", "Bash", {}, []); // parks a card → awaiting_permission
  expect(() => sup.ccAttach(id, 80, 24)).toThrow(BadCommand);
  s.permissionResolved("req-1");
  s.setStatus("idle");

  sup.ccAttach(id, 80, 24); // now it goes through
  expect(s.data.attached).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("headless prompts are rejected with a clear error while attached; detach releases", async () => {
  const { sup, id, dir, created } = await harness();
  const s = sup.get(id)!;
  s.data.claudeSessionId = "sid-123";
  sup.ccAttach(id, 80, 24);

  expect(() => sup.prompt(id, "hello from the phone")).toThrow(/attached to a terminal/);

  sup.ccDetach(id);
  expect(s.data.attached).toBe(false);
  expect(created[0]!.pty.closed).toBe(true);
  expect(s.data.status).toBe("idle");
  sup.ccDetach(id); // idempotent
  rmSync(dir, { recursive: true, force: true });
});

test("the PTY exiting on its own (user quit claude) is an implicit detach", async () => {
  const { sup, id, dir, created } = await harness();
  const s = sup.get(id)!;
  s.data.claudeSessionId = "sid-123";
  sup.ccAttach(id, 80, 24);

  created[0]!.exit(0);
  await new Promise((r) => setTimeout(r, 10)); // exited.then(...) is async
  expect(s.data.attached).toBe(false);
  expect(s.data.terminals).toBeUndefined(); // chip retired
  rmSync(dir, { recursive: true, force: true });
});

test("terminal.open on the reserved cc termId without an attach is refused", async () => {
  const { sup, id, dir, created } = await harness();
  expect(() => sup.terminalOpen(id, 80, 24, CC_ATTACH_TERM_ID)).toThrow(/no attached terminal/);
  expect(created.length).toBe(0); // and no shell was spawned under the reserved id
  rmSync(dir, { recursive: true, force: true });
});

test("archive and reset release the attach gate (no stuck attached state)", async () => {
  const { sup, id, dir, created } = await harness();
  const s = sup.get(id)!;
  s.data.claudeSessionId = "sid-123";

  sup.ccAttach(id, 80, 24);
  await sup.archive(id);
  expect(s.data.attached).toBe(false); // synchronously, not waiting on the PTY's async exit
  expect(created[0]!.pty.closed).toBe(true);

  sup.unarchive(id);
  sup.ccAttach(id, 80, 24);
  await sup.reset(id);
  expect(s.data.attached).toBe(false);
  expect(created[1]!.pty.closed).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
