/**
 * Cross-box config sync (design §4.4, §8). Sync NEVER mutates implicitly: this computes a diff, the
 * UI renders it with a checkbox per row, and only ticked rows are applied to the target. Removals are
 * deliberately unselected by default — per-box uniqueness is the point, so a member's local extras
 * must survive a careless click.
 *
 * SCOPE, deliberately: plugins, MCP servers, and the auto-mode config. **Memory is not synced**
 * (design §8, Phase B). Memory is per-repo prose written by the agent on both boxes, so a "sync"
 * would be a merge with no defined semantics — and silently overwriting one machine's memory with
 * another's is unrecoverable. Adding memory here is a design decision, not a code change; the guard
 * test says so.
 */
import type { PluginInfo } from "../cc/plugins";
import type { McpServerInfo } from "../cc/mcp";
import { AUTOMODE_SECTIONS, type AutoModeConfig } from "../cc/automode";

export interface DiffRow {
  id: string;
  name: string;
  selected: boolean;
}
export interface UpdateRow extends DiffRow {
  sourceVersion: string;
  targetVersion: string;
}
export interface PluginDiff {
  install: DiffRow[];
  remove: DiffRow[];
  update: UpdateRow[];
}

export function diffPlugins(source: PluginInfo[], target: PluginInfo[]): PluginDiff {
  const byId = (list: PluginInfo[]): Map<string, PluginInfo> => new Map(list.map((p) => [p.id, p]));
  const s = byId(source);
  const t = byId(target);
  const diff: PluginDiff = { install: [], remove: [], update: [] };

  for (const [id, sp] of s) {
    const tp = t.get(id);
    if (!tp) diff.install.push({ id, name: sp.name, selected: true });
    else if (tp.version !== sp.version) {
      diff.update.push({ id, name: sp.name, selected: true, sourceVersion: sp.version, targetVersion: tp.version });
    }
  }
  for (const [id, tp] of t) {
    if (!s.has(id)) diff.remove.push({ id, name: tp.name, selected: false });
  }
  return diff;
}

/** MCP servers diff on NAME only. The target's transport/config is deliberately not compared —
 *  a server's URL or command is frequently machine-specific (a local path, a per-box port), so
 *  reporting those as drift would make the diff noise the user learns to ignore. */
export function diffMcp(source: McpServerInfo[], target: McpServerInfo[]): { add: DiffRow[]; remove: DiffRow[] } {
  const names = (l: McpServerInfo[]): Set<string> => new Set(l.map((x) => x.name));
  const s = names(source);
  const t = names(target);
  return {
    add: [...s].filter((n) => !t.has(n)).map((n) => ({ id: n, name: n, selected: true })),
    remove: [...t].filter((n) => !s.has(n)).map((n) => ({ id: n, name: n, selected: false })),
  };
}

export interface AutoModeSectionDiff {
  section: string;
  added: string[];
  removed: string[];
}

/** Auto-mode diffs per section, as prose lines. Rules are natural language, so there is no
 *  meaningful sub-line merge — a rule is present or it is not. */
export function diffAutoMode(source: AutoModeConfig, target: AutoModeConfig): AutoModeSectionDiff[] {
  const out: AutoModeSectionDiff[] = [];
  for (const section of AUTOMODE_SECTIONS) {
    const s = source[section] ?? [];
    const t = target[section] ?? [];
    const ts = new Set(t);
    const ss = new Set(s);
    const added = s.filter((r) => !ts.has(r));
    const removed = t.filter((r) => !ss.has(r));
    if (added.length || removed.length) out.push({ section, added, removed });
  }
  return out;
}

export interface ConfigDiff {
  plugins: PluginDiff;
  mcp: { add: DiffRow[]; remove: DiffRow[] };
  autoMode: AutoModeSectionDiff[];
}

export interface ConfigSnapshot {
  plugins: PluginInfo[];
  mcp: McpServerInfo[];
  autoMode: AutoModeConfig;
}

/** The whole cross-box diff. Note the return type has no `memory` key, by design (§8 Phase B). */
export function diffConfig(source: ConfigSnapshot, target: ConfigSnapshot): ConfigDiff {
  return {
    plugins: diffPlugins(source.plugins, target.plugins),
    mcp: diffMcp(source.mcp, target.mcp),
    autoMode: diffAutoMode(source.autoMode, target.autoMode),
  };
}
