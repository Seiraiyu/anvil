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
import { toast, confirmDialog, promptDialog, pickListDialog, showModal, closeModal } from "./dialogs";
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
      <span class="cfg-actions">
        <button class="mini" data-cfg-sync>${icon("sync")} Sync…</button>
        <button class="mini" data-cfg-refresh>${icon("refresh")} Refresh</button>
      </span></div>
    <div class="cfg-block"><h5>Plugins</h5><div data-cfg-plugins><p class="small muted">Loading…</p></div>
      <button class="mini" data-plugin-install>${icon("add")} Install plugin…</button></div>
    <div class="cfg-block"><h5>MCP servers</h5><div data-cfg-mcp><p class="small muted">Loading…</p></div>
      <button class="mini" data-mcp-add>${icon("add")} Add server…</button></div>
    <div class="cfg-block"><h5>Auto mode</h5><div data-cfg-automode><p class="small muted">Loading…</p></div></div>
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

  const am = card.querySelector<HTMLElement>("[data-cfg-automode]");
  if (am) {
    const auto = await getJson<{ config: AutoModeCfg; defaults: AutoModeCfg }>(srv, "/api/cc/v1/automode");
    am.innerHTML = "";
    if (!auto) {
      am.innerHTML = `<p class="small warn">Couldn't read the auto-mode config.</p>`;
    } else {
      for (const section of AUTOMODE_SECTIONS) {
        am.appendChild(renderAutoModeSection(section, auto.config[section] ?? [], auto.defaults[section] ?? []));
      }
      const bar = document.createElement("div");
      bar.className = "cfg-actions";
      bar.innerHTML = `<button class="mini" data-am-save>Save</button>
        <button class="mini" data-am-critique>Check my rules</button>
        <button class="mini danger" data-am-reset>Reset to defaults</button>`;
      am.appendChild(bar);
      wireAutoMode(srv, am);
    }
  }
  wireCard(srv, card);
}

function wireAutoMode(srv: Server, am: HTMLElement): void {
  const save = am.querySelector<HTMLButtonElement>("[data-am-save]");
  save?.addEventListener("click", async () => {
    const cfg = collectAutoMode(am);
    // Confirm ONCE, naming every section that would lose its built-ins. This is the last point at
    // which the discard is reversible by the user, and CC will not complain afterwards.
    const losing = AUTOMODE_SECTIONS.filter((s) => !cfg[s].includes(DEFAULTS_SENTINEL));
    if (losing.length) {
      const ok = await confirmDialog({
        title: `Discard Claude Code's built-in rules for ${losing.join(", ")}?`,
        body: `Those sections omit ${DEFAULTS_SENTINEL}. Saving replaces Claude Code's built-in rules for them entirely — it will not warn you again.`,
        danger: true,
        confirmLabel: "Save anyway",
      });
      if (!ok) return;
    }
    await busy(save, "saving…", async () => {
      const res = await serverFetch(srv.url, "/api/cc/v1/automode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: cfg }),
      });
      toast(res.ok ? "Auto-mode config saved — applies to the next turn" : `Save failed: ${await res.text()}`);
    });
  });

  const critique = am.querySelector<HTMLButtonElement>("[data-am-critique]");
  critique?.addEventListener("click", async () => {
    await busy(critique, "checking…", async () => {
      const res = await serverFetch(srv.url, "/api/cc/v1/automode/critique", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        toast(`Critique failed: ${await res.text()}`);
        return;
      }
      const { critique: text } = (await res.json()) as { critique: string };
      const box = document.createElement("div");
      box.innerHTML = `<div class="modal-box"><h3>${icon("rule")} Auto-mode critique</h3>
        <pre class="small am-critique">${esc(text)}</pre>
        <div class="btns"><button type="button" class="primary" data-close>Close</button></div></div>`;
      box.querySelector("[data-close]")?.addEventListener("click", () => closeModal());
      showModal(box);
    });
  });

  const reset = am.querySelector<HTMLButtonElement>("[data-am-reset]");
  reset?.addEventListener("click", async () => {
    if (!(await confirmDialog({ title: "Reset auto-mode config to Claude Code's defaults?", danger: true }))) return;
    await busy(reset, "resetting…", async () => {
      const res = await serverFetch(srv.url, "/api/cc/v1/automode/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      toast(res.ok ? "Auto-mode config reset" : `Reset failed: ${await res.text()}`);
      if (res.ok) await loadServer(srv);
    });
  });
}

/** The memory file editor. Carries `expectedModified` back on save, so a concurrent agent write is
 *  rejected with a 409 rather than silently clobbered — Claude writes this directory mid-session. */
async function openMemoryFile(srv: Server, name: string): Promise<void> {
  const res = await serverFetch(srv.url, `/api/cc/v1/memory/${encodeURIComponent(name)}`);
  if (!res.ok) {
    toast(`Couldn't open ${name}: ${await res.text()}`);
    return;
  }
  const file = (await res.json()) as { text: string; modified: string; budget: { lines: number; state: string } };
  const box = document.createElement("div");
  const overBudget = file.budget.state !== "ok";
  box.innerHTML = `<div class="modal-box">
    <h3>${icon("description")} ${esc(name)}</h3>
    <p class="small ${overBudget ? "warn" : "muted"}">${file.budget.lines} lines · budget ${esc(file.budget.state)}${
      overBudget ? " — Claude Code loads only the first 200 lines or 25KB of MEMORY.md; the rest is dropped." : ""
    }</p>
    <textarea id="mem-text" class="am-text" rows="18" spellcheck="false">${esc(file.text)}</textarea>
    <div class="btns"><button type="button" id="mem-cancel">Cancel</button>
      <button type="button" id="mem-save" class="primary">Save</button></div></div>`;
  const saveBtn = box.querySelector<HTMLButtonElement>("#mem-save")!;
  box.querySelector("#mem-cancel")?.addEventListener("click", () => closeModal());
  saveBtn.addEventListener("click", async () => {
    const text = box.querySelector<HTMLTextAreaElement>("#mem-text")!.value;
    await busy(saveBtn, "saving…", async () => {
      const put = await serverFetch(srv.url, `/api/cc/v1/memory/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, expectedModified: file.modified }),
      });
      if (put.status === 409) {
        toast(`${name} changed on disk (Claude wrote it) — reopen to merge your edit`);
        return;
      }
      toast(put.ok ? `${name} saved — applies to the next turn` : `Save failed: ${await put.text()}`);
      if (put.ok) {
        closeModal();
        await loadServer(srv);
      }
    });
  });
  showModal(box);
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

  card.querySelectorAll<HTMLButtonElement>("[data-mem-open]").forEach((btn) => {
    btn.addEventListener("click", () => void busy(btn, "…", () => openMemoryFile(srv, btn.dataset.memOpen!)));
  });

  const install = card.querySelector<HTMLButtonElement>("[data-plugin-install]");
  install?.addEventListener("click", async () => {
    const id = await promptDialog({
      title: "Install a plugin",
      placeholder: "name@marketplace",
      confirmLabel: "Install",
      icon: "extension",
    });
    if (!id) return;
    await busy(install, "installing…", async () => {
      const res = await serverFetch(srv.url, "/api/cc/v1/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      toast(res.ok ? `${id} installed — applies to the next turn` : `Install failed: ${await res.text()}`);
      if (res.ok) await loadServer(srv);
    });
  });

  const addMcp = card.querySelector<HTMLButtonElement>("[data-mcp-add]");
  addMcp?.addEventListener("click", () => void showAddMcpServer(srv));

  const sync = card.querySelector<HTMLButtonElement>("[data-cfg-sync]");
  sync?.addEventListener("click", () => void startSync(srv));

  const refresh = card.querySelector<HTMLButtonElement>("[data-cfg-refresh]");
  refresh?.addEventListener("click", () => void busy(refresh, "…", () => loadServer(srv)));
}

/**
 * Add an MCP server. The whole config travels as ONE JSON argument to `claude mcp add-json`, so a
 * command with spaces, or a header value with punctuation, is never shell-split.
 *
 * [SEC] This modal holds secrets (bearer headers, API keys in env). Its values are never echoed into
 * a toast, never logged, and never re-rendered into markup (design §8).
 */
export async function showAddMcpServer(srv: Server): Promise<void> {
  const box = document.createElement("div");
  box.innerHTML = `<div class="modal-box">
    <h3>${icon("hub")} Add MCP server</h3>
    <label class="ap-field"><span class="small muted">Name</span>
      <input type="text" id="mcp-name" placeholder="sentry" /></label>
    <label class="ap-field"><span class="small muted">Transport</span>
      <select id="mcp-type"><option value="http">http</option><option value="sse">sse</option><option value="stdio">stdio</option></select></label>
    <label class="ap-field" id="mcp-url-field"><span class="small muted">URL</span>
      <input type="text" id="mcp-url" placeholder="https://mcp.example.com/mcp" /></label>
    <label class="ap-field hidden" id="mcp-cmd-field"><span class="small muted">Command and arguments</span>
      <input type="text" id="mcp-cmd" placeholder="node /path/to/server.js --flag" /></label>
    <label class="ap-field"><span class="small muted">Headers or env — one <code>KEY=value</code> per line</span>
      <textarea id="mcp-extra" rows="3" spellcheck="false"></textarea></label>
    <div class="btns"><button type="button" id="mcp-cancel">Cancel</button>
      <button type="button" id="mcp-ok" class="primary">Add</button></div></div>`;
  const typeSel = box.querySelector<HTMLSelectElement>("#mcp-type")!;
  const urlField = box.querySelector<HTMLElement>("#mcp-url-field")!;
  const cmdField = box.querySelector<HTMLElement>("#mcp-cmd-field")!;
  typeSel.addEventListener("change", () => {
    const stdio = typeSel.value === "stdio";
    urlField.classList.toggle("hidden", stdio);
    cmdField.classList.toggle("hidden", !stdio);
  });
  box.querySelector("#mcp-cancel")?.addEventListener("click", () => closeModal());
  const ok = box.querySelector<HTMLButtonElement>("#mcp-ok")!;
  ok.addEventListener("click", async () => {
    const name = box.querySelector<HTMLInputElement>("#mcp-name")!.value.trim();
    if (!name) {
      toast("A name is required");
      return;
    }
    const kv: Record<string, string> = {};
    for (const line of box.querySelector<HTMLTextAreaElement>("#mcp-extra")!.value.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) kv[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const type = typeSel.value;
    let config: Record<string, unknown>;
    if (type === "stdio") {
      const parts = box.querySelector<HTMLInputElement>("#mcp-cmd")!.value.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) {
        toast("A command is required");
        return;
      }
      config = { command: parts[0], args: parts.slice(1), ...(Object.keys(kv).length ? { env: kv } : {}) };
    } else {
      const url = box.querySelector<HTMLInputElement>("#mcp-url")!.value.trim();
      if (!url) {
        toast("A URL is required");
        return;
      }
      config = { type, url, ...(Object.keys(kv).length ? { headers: kv } : {}) };
    }
    await busy(ok, "adding…", async () => {
      const res = await serverFetch(srv.url, "/api/cc/v1/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "add", name, config }),
      });
      // Only the NAME is ever echoed back — config may carry a bearer token.
      toast(res.ok ? `${name} added — applies to the next turn` : `Add failed: ${await res.text()}`);
      if (res.ok) {
        closeModal();
        await loadServer(srv);
      }
    });
  });
  showModal(box);
}

// ── sync (design §4.4) ──────────────────────────────────────────────────────────────────────────

export interface SyncDiff {
  plugins: {
    install: { id: string; name: string; selected: boolean }[];
    remove: { id: string; name: string; selected: boolean }[];
    update: { id: string; name: string; selected: boolean; sourceVersion: string; targetVersion: string }[];
  };
  mcp: { add: { id: string; name: string }[]; remove: { id: string; name: string }[] };
  autoMode: { section: string; added: string[]; removed: string[] }[];
}

/** Diff rows, each with a checkbox. Removals render UNCHECKED — per-box uniqueness is the point of
 *  the feature, so a member's local extras must survive a careless "Apply". */
export function syncDiffMarkup(diff: SyncDiff): string {
  const rows = (kind: string, list: { id: string; name: string }[], checked: boolean, label: string): string =>
    list
      .map(
        (r) => `<label class="cfg-row"><input type="checkbox" data-sync="${kind}" value="${esc(r.id)}"${
          checked ? " checked" : ""
        } /> <span class="cfg-name">${esc(label)} ${esc(r.name)}<span class="small muted"> (${esc(r.id)})</span></span></label>`,
      )
      .join("");
  const parts = [
    rows("install", diff.plugins.install, true, "Install"),
    rows("update", diff.plugins.update, true, "Update"),
    rows("remove", diff.plugins.remove, false, "Remove"),
  ].filter(Boolean);
  const mcpNote =
    diff.mcp.add.length || diff.mcp.remove.length
      ? `<p class="small muted">MCP differences: ${diff.mcp.add.length} to add, ${diff.mcp.remove.length} only here. Add or remove them on the server's own card — transports are usually machine-specific.</p>`
      : "";
  const amNote = diff.autoMode.length
    ? `<p class="small muted">Auto-mode rules differ in: ${diff.autoMode.map((a) => esc(a.section)).join(", ")}. Edit those on the card — prose rules are not safe to copy blind.</p>`
    : "";
  if (!parts.length && !mcpNote && !amNote) return `<p class="small muted">These machines already match.</p>`;
  return `${parts.join("") || `<p class="small muted">No plugin differences.</p>`}${mcpNote}${amNote}`;
}

async function startSync(target: Server): Promise<void> {
  const others = [...servers.values()].filter((s) => s.url !== target.url && serverSupports(s, "cc-config"));
  if (!others.length) {
    toast("No other connected server supports config management");
    return;
  }
  const sourceUrl = await pickListDialog(
    `Copy configuration to ${target.name} from…`,
    others.map((s) => ({ id: s.url, label: s.name, icon: "dns" })),
  );
  if (!sourceUrl) return;

  const res = await serverFetch(target.url, "/api/cc/v1/sync/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceUrl }),
  });
  if (!res.ok) {
    // A failed plan must never render as "already in sync" — that reads as "nothing to do".
    toast(`Couldn't read the source server: ${await res.text()}`);
    return;
  }
  const { diff } = (await res.json()) as { diff: SyncDiff };
  const box = document.createElement("div");
  box.innerHTML = `<div class="modal-box">
    <h3>${icon("sync")} Sync to ${esc(target.name)}</h3>
    <p class="small muted">Only the rows you tick are applied. Removals start unticked.</p>
    <div id="sync-rows">${syncDiffMarkup(diff)}</div>
    <div class="btns"><button type="button" id="sync-cancel">Cancel</button>
      <button type="button" id="sync-ok" class="primary">Apply</button></div></div>`;
  box.querySelector("#sync-cancel")?.addEventListener("click", () => closeModal());
  const ok = box.querySelector<HTMLButtonElement>("#sync-ok")!;
  ok.addEventListener("click", async () => {
    const pick = (kind: string): string[] =>
      [...box.querySelectorAll<HTMLInputElement>(`input[data-sync="${kind}"]`)]
        .filter((c) => c.checked)
        .map((c) => c.value);
    const body = { install: pick("install"), update: pick("update"), remove: pick("remove") };
    await busy(ok, "applying…", async () => {
      const r = await serverFetch(target.url, "/api/cc/v1/sync/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await r.json()) as { ok: boolean; results: { id: string; ok: boolean; error?: string }[] };
      const failed = out.results.filter((x) => !x.ok);
      // Per-item truth: never report success when any row failed (design §7).
      toast(
        failed.length
          ? `${out.results.length - failed.length} applied, ${failed.length} failed (${failed[0]!.id}: ${failed[0]!.error ?? "unknown"})`
          : `${out.results.length} applied — each takes effect on that session's next turn`,
      );
      closeModal();
      await loadServer(target);
    });
  });
  showModal(box);
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
