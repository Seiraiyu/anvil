/**
 * Settings → Claude Code: the per-machine `~/.claude` surface (cc-config design §6).
 *
 * Four domains, one card per fleet server: plugins, MCP servers, the auto-mode classifier config,
 * and memory. Everything is gated on the server's `cc-config` capability, so an older daemon renders
 * nothing rather than dead controls.
 *
 * Two rules this module exists to enforce:
 *  - **Never render a secret.** MCP configs carry headers, env and tokens. Rows show name, target
 *    and status only (design §8); the add-server modal's values are never echoed into a toast.
 *  - **Never let `$defaults` be dropped by accident.** Saving an auto-mode section without the
 *    literal "$defaults" silently discards CC's entire built-in list for it, with no CLI error.
 *    `defaultsWarning` is the guard, and the editor seeds the sentinel into every new section.
 */
import { esc, icon, busy } from "./dom";
import { toast, confirmDialog } from "./dialogs";
import { serverFetch, serverSupports, servers, cssId, type Server } from "./fleet";

// ── types mirroring the REST payloads (design §7) ───────────────────────────────────────────────

export interface PluginRow {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  enabled: boolean;
  scope: string;
  mcpServers: string[];
}
export interface McpRow {
  name: string;
  target?: string;
  connected: boolean;
  raw?: boolean;
}
export interface AutoModeCfg {
  allow: string[];
  soft_deny: string[];
  hard_deny: string[];
  environment: string[];
}
export interface MemoryFileRow {
  name: string;
  bytes: number;
  modified: string;
}
export interface MemorySettingsRow {
  autoMemoryEnabled: boolean;
  autoMemoryDirectory?: string;
}

export const AUTOMODE_SECTIONS = ["allow", "soft_deny", "hard_deny", "environment"] as const;
export type AutoModeSectionName = (typeof AUTOMODE_SECTIONS)[number];
export const DEFAULTS_SENTINEL = "$defaults";

/** Null when the edit inherits CC's built-ins; otherwise the warning to show before saving. */
export function defaultsWarning(entries: string[], builtinCount: number): string | null {
  if (entries.includes(DEFAULTS_SENTINEL)) return null;
  return `This section omits ${DEFAULTS_SENTINEL}, so saving will discard all ${builtinCount} of Claude Code's built-in rules for it. Add "${DEFAULTS_SENTINEL}" to keep them.`;
}

/** Split a textarea's text into rule entries: one per line, blanks dropped, order preserved. */
export function parseSectionText(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Human size for a memory file row. */
export function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/**
 * One auto-mode section editor. A section with no entries is SEEDED with `$defaults` rather than
 * left empty, because an empty array is not "no opinion" to CC — it discards the built-ins.
 */
export function renderAutoModeSection(
  section: AutoModeSectionName,
  entries: string[],
  builtins: string[],
): HTMLElement {
  const el = document.createElement("div");
  el.className = "am-section";
  el.dataset.section = section;
  const seeded = entries.length ? entries : [DEFAULTS_SENTINEL];
  const warn = defaultsWarning(seeded, builtins.length);
  el.innerHTML = `
    <label class="am-label"><strong>${esc(section)}</strong>
      <span class="small muted">${builtins.length} built-in rule(s) available via ${esc(DEFAULTS_SENTINEL)}</span>
    </label>
    <textarea class="am-text" rows="6" spellcheck="false">${esc(seeded.join("\n"))}</textarea>
    <p class="am-warn small${warn ? "" : " hidden"}">${warn ? esc(warn) : ""}</p>`;
  const ta = el.querySelector<HTMLTextAreaElement>("textarea")!;
  const warnEl = el.querySelector<HTMLElement>(".am-warn")!;
  ta.addEventListener("input", () => {
    const w = defaultsWarning(parseSectionText(ta.value), builtins.length);
    warnEl.textContent = w ?? "";
    warnEl.classList.toggle("hidden", !w);
  });
  return el;
}

/** Read the four sections back out of a rendered editor. */
export function collectAutoMode(root: ParentNode): AutoModeCfg {
  const out: AutoModeCfg = { allow: [], soft_deny: [], hard_deny: [], environment: [] };
  for (const section of AUTOMODE_SECTIONS) {
    const ta = root.querySelector<HTMLTextAreaElement>(`.am-section[data-section="${section}"] textarea`);
    if (ta) out[section] = parseSectionText(ta.value);
  }
  return out;
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────

export function pluginRowsMarkup(plugins: PluginRow[]): string {
  if (!plugins.length) return `<p class="small muted">No plugins installed.</p>`;
  return plugins
    .map(
      (p) => `<div class="cfg-row">
      <span class="cfg-name">${esc(p.name)}<span class="small muted"> @${esc(p.marketplace || "local")} · ${esc(p.version)}${p.enabled ? "" : " · disabled"}</span></span>
      <span class="cfg-actions">
        <button class="mini" data-op="${p.enabled ? "disable" : "enable"}" data-id="${esc(p.id)}">${p.enabled ? "Disable" : "Enable"}</button>
        <button class="mini" data-op="update" data-id="${esc(p.id)}">Update</button>
        <button class="mini danger" data-op="uninstall" data-id="${esc(p.id)}">Uninstall</button>
      </span></div>`,
    )
    .join("");
}

export function mcpRowsMarkup(servers_: McpRow[]): string {
  if (!servers_.length) return `<p class="small muted">No MCP servers configured.</p>`;
  return servers_
    .map((s) => {
      // A line the tolerant parser could not read is shown verbatim rather than dropped, so a CLI
      // format change is visible as odd text instead of a silently missing server.
      if (s.raw) {
        return `<div class="cfg-row"><code class="small">${esc(s.name)}</code><span class="small muted">couldn't parse this line</span></div>`;
      }
      // Name, target and status ONLY — an MCP config carries headers/env/tokens (design §8).
      return `<div class="cfg-row">
        <span class="cfg-name">${esc(s.name)}<span class="small muted"> — ${esc(s.target ?? "")}</span></span>
        <span class="cfg-actions">
          <span class="small ${s.connected ? "ok" : "warn"}">${s.connected ? "✔ connected" : "⚠ needs attention"}</span>
          <button class="mini danger" data-mcp-remove="${esc(s.name)}">Remove</button>
        </span></div>`;
    })
    .join("");
}

export function memoryRowsMarkup(files: MemoryFileRow[]): string {
  if (!files.length) return `<p class="small muted">No memory files yet.</p>`;
  return files
    .map(
      (f) => `<div class="cfg-row">
      <span class="cfg-name">${esc(f.name)}<span class="small muted"> · ${esc(fmtBytes(f.bytes))}</span></span>
      <span class="cfg-actions">
        <button class="mini" data-mem-open="${esc(f.name)}">Open</button>
        <button class="mini danger" data-mem-delete="${esc(f.name)}">Delete</button>
      </span></div>`,
    )
    .join("");
}

/** The per-server card shell. Populated by `loadServer`. */
export function serverCardMarkup(srv: Server): string {
  const id = cssId(srv.url);
  return `<div class="cfg-card" id="ccfg-${id}" data-url="${esc(srv.url)}">
    <div class="section-head"><h4>${esc(srv.name)}</h4>
      <button class="mini" data-cfg-refresh>${icon("refresh")} Refresh</button></div>
    <div class="cfg-block"><h5>Plugins</h5><div data-cfg-plugins><p class="small muted">Loading…</p></div></div>
    <div class="cfg-block"><h5>MCP servers</h5><div data-cfg-mcp><p class="small muted">Loading…</p></div></div>
    <div class="cfg-block"><h5>Memory</h5><div data-cfg-memory><p class="small muted">Loading…</p></div></div>
  </div>`;
}

// ── data loading + wiring ───────────────────────────────────────────────────────────────────────

async function getJson<T>(srv: Server, path: string): Promise<T | undefined> {
  try {
    const res = await serverFetch(srv.url, path);
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

export async function loadServer(srv: Server): Promise<void> {
  const card = document.getElementById(`ccfg-${cssId(srv.url)}`);
  if (!card) return;
  const plugins = await getJson<{ plugins: PluginRow[] }>(srv, "/api/cc/v1/plugins");
  const mcp = await getJson<{ servers: McpRow[] }>(srv, "/api/cc/v1/mcp");
  const mem = await getJson<{ files: MemoryFileRow[] }>(srv, "/api/cc/v1/memory");

  const p = card.querySelector<HTMLElement>("[data-cfg-plugins]");
  if (p) p.innerHTML = plugins ? pluginRowsMarkup(plugins.plugins) : `<p class="small warn">Couldn't read plugins.</p>`;
  const m = card.querySelector<HTMLElement>("[data-cfg-mcp]");
  if (m) m.innerHTML = mcp ? mcpRowsMarkup(mcp.servers) : `<p class="small warn">Couldn't read MCP servers.</p>`;
  const mm = card.querySelector<HTMLElement>("[data-cfg-memory]");
  if (mm) {
    // A 400 here is the ordinary "no turn has run yet" case, not a fault — say what to do about it.
    mm.innerHTML = mem
      ? memoryRowsMarkup(mem.files)
      : `<p class="small muted">Run a turn on this server to locate its memory.</p>`;
  }
  wireCard(srv, card);
}

function wireCard(srv: Server, card: HTMLElement): void {
  card.querySelectorAll<HTMLButtonElement>("[data-op]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const op = btn.dataset.op!;
      const id = btn.dataset.id!;
      if (
        (op === "uninstall" || op === "disable") &&
        !(await confirmDialog({ title: `${op === "uninstall" ? "Uninstall" : "Disable"} ${id}?`, danger: true }))
      ) {
        return;
      }
      await busy(btn, `${op}…`, async () => {
        const res = await serverFetch(srv.url, `/api/cc/v1/plugins/${op}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) {
          toast(`${op} failed: ${await res.text()}`);
          return;
        }
        toast(`${id} ${op}d — applies to the next turn`);
        await loadServer(srv);
      });
    });
  });

  card.querySelectorAll<HTMLButtonElement>("[data-mcp-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.mcpRemove!;
      if (!(await confirmDialog({ title: `Remove MCP server ${name}?`, danger: true }))) return;
      await busy(btn, "removing…", async () => {
        const res = await serverFetch(srv.url, "/api/cc/v1/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "remove", name }),
        });
        // Never echo the server's config into the toast — it carries headers/env (design §8).
        toast(res.ok ? `${name} removed — applies to the next turn` : `Remove failed: ${await res.text()}`);
        if (res.ok) await loadServer(srv);
      });
    });
  });

  card.querySelectorAll<HTMLButtonElement>("[data-mem-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.memDelete!;
      if (!(await confirmDialog({ title: `Delete ${name}?`, body: "Memory is not recoverable.", danger: true }))) return;
      await busy(btn, "deleting…", async () => {
        const res = await serverFetch(srv.url, `/api/cc/v1/memory/${encodeURIComponent(name)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
        });
        toast(res.ok ? `${name} deleted` : `Delete failed: ${await res.text()}`);
        if (res.ok) await loadServer(srv);
      });
    });
  });

  const refresh = card.querySelector<HTMLButtonElement>("[data-cfg-refresh]");
  refresh?.addEventListener("click", () => void busy(refresh, "…", () => loadServer(srv)));
}

/** Paint the whole section: one card per capable server. */
export function renderCcConfig(): void {
  const root = document.getElementById("ccconfig-cards");
  if (!root) return;
  const capable = [...servers.values()].filter((s) => serverSupports(s, "cc-config"));
  if (!capable.length) {
    root.innerHTML = `<p class="small muted">No connected server supports Claude Code config management.</p>`;
    return;
  }
  root.innerHTML = capable.map(serverCardMarkup).join("");
  for (const srv of capable) void loadServer(srv);
}
