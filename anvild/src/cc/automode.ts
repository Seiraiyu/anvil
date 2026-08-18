/**
 * Auto-mode classifier configuration (cc-config design §6.5). Claude Code shipped `auto` as a
 * permission mode on 2026-08-14: a classifier blocks irreversible/destructive/exfiltrating actions.
 * The `autoMode` settings block tunes that classifier.
 *
 * Anvil reads the EFFECTIVE config through `claude auto-mode config` rather than reading
 * settings.json, because the effective value is the merge of user + managed + `--settings` scopes and
 * only the CLI knows that merge (design principle 1: never reimplement CC's logic).
 *
 * The `$defaults` sentinel is the sharp edge. Setting any section WITHOUT the literal "$defaults"
 * string replaces CC's entire built-in list for that section — silently. `splicedPreview` renders
 * what a given edit actually produces so the UI can show it, and `hasDefaultsSentinel` drives the
 * warning.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveCcCommand, defaultRun, type CommandRunner } from "./install";

export const AUTOMODE_SECTIONS = ["allow", "soft_deny", "hard_deny", "environment"] as const;
export type AutoModeSection = (typeof AUTOMODE_SECTIONS)[number];

/** The four prose rule lists. Every entry is natural language, never a pattern — pass through verbatim. */
export type AutoModeConfig = Record<AutoModeSection, string[]>;

/** The literal string that splices CC's built-in rules into a user array at that position. */
export const DEFAULTS_SENTINEL = "$defaults";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Parse `claude auto-mode config|defaults` output. Throws on non-JSON: a silently-empty config
 *  would render as "no rules", which would misrepresent the machine's actual safety posture. */
export function parseAutoModeConfig(raw: string): AutoModeConfig {
  const j = JSON.parse(raw) as Record<string, unknown>;
  if (!j || typeof j !== "object") throw new Error("auto-mode config is not an object");
  return {
    allow: strings(j.allow),
    soft_deny: strings(j.soft_deny),
    hard_deny: strings(j.hard_deny),
    environment: strings(j.environment),
  };
}

/** True when the array will INHERIT CC's built-ins. An empty array does not — it discards them. */
export function hasDefaultsSentinel(entries: string[]): boolean {
  return entries.includes(DEFAULTS_SENTINEL);
}

/** What `entries` actually resolves to, with `defaults` spliced in at the sentinel's position.
 *  Without the sentinel the defaults are dropped entirely — that is CC's behavior, reproduced here
 *  so the UI can show the user the loss before they save. */
export function splicedPreview(entries: string[], defaults: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e === DEFAULTS_SENTINEL) out.push(...defaults);
    else out.push(e);
  }
  return out;
}

async function ccAutoMode(args: string[], run: CommandRunner, env: Record<string, string | undefined>): Promise<string> {
  const cmd = resolveCcCommand(env);
  const r = await run([...cmd, "auto-mode", ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`claude auto-mode ${args.join(" ")} failed: ${r.out.slice(-800)}`);
  return r.out;
}

/** The effective config: the user's settings merged over CC's built-ins. */
export async function readAutoModeConfig(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<AutoModeConfig> {
  return parseAutoModeConfig(await ccAutoMode(["config"], run, env));
}

/** CC's built-in rules — what `$defaults` splices in. Needed to render `splicedPreview`. */
export async function readAutoModeDefaults(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<AutoModeConfig> {
  return parseAutoModeConfig(await ccAutoMode(["defaults"], run, env));
}

/**
 * Write the `autoMode` block into the USER settings file, merging over whatever else is there.
 *
 * [SEC] Always `~/.claude/settings.json` — never a project settings file. CC deliberately excludes
 * `.claude/settings.json` and `.claude/settings.local.json` from autoMode resolution so a checked-in
 * repo cannot inject its own allow rules; writing there would reopen the hole CC closed
 * (design §9).
 *
 * Empty sections are OMITTED rather than written as `[]`, because `[]` is not "no opinion" — it
 * discards CC's entire built-in list for that section.
 */
export function writeAutoModeBlock(cfg: AutoModeConfig, home: string = homedir()): void {
  const dir = join(home, ".claude");
  const path = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    /* absent or unparseable — treat as empty and rewrite (CC would ignore an unparseable file too) */
  }

  const block: Record<string, string[]> = {};
  for (const s of AUTOMODE_SECTIONS) if (cfg[s].length) block[s] = cfg[s];

  writeFileSync(path, `${JSON.stringify({ ...current, autoMode: block }, null, 2)}\n`, { mode: 0o600 });
}

/** `claude auto-mode critique` — AI feedback on custom rules. Returns the CLI's prose verbatim. */
export async function critiqueAutoMode(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  return ccAutoMode(["critique"], run, env);
}

/** `claude auto-mode reset --yes` — removes the autoMode section from user settings.
 *  `--yes` is required: the prompt has no TTY to answer it (flag verified against 2.1.233). */
export async function resetAutoMode(
  run: CommandRunner = defaultRun,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  await ccAutoMode(["reset", "--yes"], run, env);
}
