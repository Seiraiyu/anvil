/**
 * Records golden stream-json fixtures from the REAL claude CLI (design §8, Assumptions 1/3/5
 * + Spike 3). Requires an authenticated `claude` on PATH (or argv[2] = path to binary).
 *
 *   bun test/tools/record-cc-stream.ts [claude-binary]
 *
 * Writes test/fixtures/cc/{basic,tool,resume}.ndjson + cc-version.txt. Scenarios:
 *   basic  — one text-only turn (also exercises --include-partial-messages deltas: Spike 3)
 *   tool   — a turn that must call the Read tool (bypassPermissions; sandbox temp dir)
 *   resume — second process resuming the basic session (Assumption on --resume)
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2] ?? "claude";
const outDir = join(import.meta.dir, "..", "fixtures", "cc");
mkdirSync(outDir, { recursive: true });

async function run(args: string[], stdin: string | undefined, cwd: string): Promise<string> {
  const proc = Bun.spawn([bin, ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : new Response(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${bin} ${args.join(" ")} exited ${code}\n${err}`);
  return out;
}

const COMMON = [
  "-p",
  "--output-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--model", "haiku",
  "--permission-mode", "bypassPermissions",
];

const cwd = mkdtempSync(join(tmpdir(), "anvil-cc-record-"));
writeFileSync(join(cwd, "note.txt"), "the magic word is xylophone\n");

const version = await run(["--version"], undefined, cwd);
writeFileSync(join(outDir, "cc-version.txt"), version);

const basic = await run([...COMMON, "Reply with exactly: ok"], undefined, cwd);
writeFileSync(join(outDir, "basic.ndjson"), basic);

const init = basic.split("\n").map((l) => { try { return JSON.parse(l); } catch { return undefined; } })
  .find((m) => m?.type === "system" && m?.subtype === "init");
if (!init?.session_id) throw new Error("no system/init session_id in basic recording");

const tool = await run([...COMMON, "Use the Read tool to read note.txt, then reply with the magic word only."], undefined, cwd);
writeFileSync(join(outDir, "tool.ndjson"), tool);

const resume = await run([...COMMON, "--resume", init.session_id, "What were you asked to reply with exactly, one word?"], undefined, cwd);
writeFileSync(join(outDir, "resume.ndjson"), resume);

console.log(`recorded to ${outDir} (cc ${version.trim()})`);
