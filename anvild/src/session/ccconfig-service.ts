/**
 * The `~/.claude` config domain (cc-config design §4.1), following the P7 injected-deps pattern:
 * every outside effect arrives through `CcConfigServiceDeps`, so the supervisor stays thin and tests
 * never shell out to a real `claude` or touch a real `~/.claude`.
 *
 * Four domains behind one service: plugins, MCP servers, the auto-mode classifier config, and
 * memory. They share a single mutation lock because they all write the same `~/.claude` tree — two
 * concurrent `claude plugin install` runs would interleave in the plugin cache, and an auto-mode
 * write racing a memory-settings write would lose one of them (both patch settings.json).
 */
import type { PluginInfo, PluginOp, MarketplaceOp } from "../cc/plugins";
import type { McpServerInfo } from "../cc/mcp";
import type { AutoModeConfig } from "../cc/automode";
import type { MemoryFile, MemoryBudget, MemorySettings } from "../cc/memory";
import { BadCommand } from "./errors";

export interface CcConfigServiceDeps {
  // ── plugins + marketplaces ──
  listPlugins: () => Promise<PluginInfo[]>;
  listAvailable: () => Promise<PluginInfo[]>;
  pluginOp: (op: PluginOp, id: string, scope?: string) => Promise<string>;
  listMarketplaces: () => Promise<unknown>;
  marketplaceOp: (op: MarketplaceOp, source: string) => Promise<string>;
  // ── mcp ──
  listMcp: () => Promise<McpServerInfo[]>;
  addMcp: (name: string, config: Record<string, unknown>) => Promise<string>;
  removeMcp: (name: string) => Promise<string>;
  // ── auto mode ──
  readAutoMode: () => Promise<AutoModeConfig>;
  readAutoModeDefaults: () => Promise<AutoModeConfig>;
  writeAutoMode: (cfg: AutoModeConfig) => void;
  critiqueAutoMode: () => Promise<string>;
  resetAutoMode: () => Promise<void>;
  // ── memory ──
  listMemory: (dir: string) => MemoryFile[];
  readMemory: (dir: string, name: string) => { text: string; modified: string };
  writeMemory: (dir: string, name: string, text: string, expectedModified?: string) => { modified: string };
  deleteMemory: (dir: string, name: string) => void;
  memoryBudget: (text: string) => MemoryBudget;
  readMemorySettings: () => MemorySettings;
  writeMemorySettings: (patch: { autoMemoryEnabled?: boolean; autoMemoryDirectory?: string | null }) => void;
  /** The CC binary vector + env, so every adapter call inherits account selection. */
  ccEnv: () => Record<string, string | undefined>;
  /** The memory directory CC reported on the last turn (`init.memory_paths.auto`). Undefined until a
   *  turn has run — the UI shows "run a turn to locate memory" rather than guessing a path. */
  memoryDir: () => string | undefined;
}

export class CcConfigService {
  constructor(private readonly deps: CcConfigServiceDeps) {}

  /** One mutation at a time per daemon: the CLI writes shared state under ~/.claude, and two
   *  concurrent installs would interleave. (The autopilot re-entrancy bug is the same shape.) */
  private busy = false;

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new BadCommand("a Claude Code config operation is already in progress on this server");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false; // cleared on failure too, so one error can't wedge the server
    }
  }

  // ── reads (no lock: they do not mutate, and blocking them behind a slow install would make the
  //    page unreadable exactly when the user most wants to watch progress) ──
  list(): Promise<PluginInfo[]> {
    return this.deps.listPlugins();
  }
  available(): Promise<PluginInfo[]> {
    return this.deps.listAvailable();
  }
  marketplaces(): Promise<unknown> {
    return this.deps.listMarketplaces();
  }
  mcp(): Promise<McpServerInfo[]> {
    return this.deps.listMcp();
  }
  autoMode(): Promise<AutoModeConfig> {
    return this.deps.readAutoMode();
  }
  autoModeDefaults(): Promise<AutoModeConfig> {
    return this.deps.readAutoModeDefaults();
  }
  memorySettings(): MemorySettings {
    return this.deps.readMemorySettings();
  }

  /** The memory dir, or a BadCommand naming the reason — CC reports it on `init`, so before any turn
   *  has run there is nothing to read and guessing a project slug would reimplement CC (principle 1). */
  private requireMemoryDir(): string {
    const dir = this.deps.memoryDir();
    if (!dir) throw new BadCommand("memory location unknown — run a turn on this server first");
    return dir;
  }

  memoryFiles(): MemoryFile[] {
    return this.deps.listMemory(this.requireMemoryDir());
  }

  /** File contents plus the budget CC will apply when it loads them. */
  memoryFile(name: string): { text: string; modified: string; budget: MemoryBudget } {
    const r = this.deps.readMemory(this.requireMemoryDir(), name);
    return { ...r, budget: this.deps.memoryBudget(r.text) };
  }

  // ── mutations (serialised) ──
  op(op: PluginOp, id: string, scope?: string): Promise<string> {
    return this.exclusive(() => this.deps.pluginOp(op, id, scope));
  }
  marketplace(op: MarketplaceOp, source: string): Promise<string> {
    return this.exclusive(() => this.deps.marketplaceOp(op, source));
  }
  addMcp(name: string, config: Record<string, unknown>): Promise<string> {
    return this.exclusive(() => this.deps.addMcp(name, config));
  }
  removeMcp(name: string): Promise<string> {
    return this.exclusive(() => this.deps.removeMcp(name));
  }
  writeAutoMode(cfg: AutoModeConfig): Promise<void> {
    return this.exclusive(async () => this.deps.writeAutoMode(cfg));
  }
  critique(): Promise<string> {
    return this.exclusive(() => this.deps.critiqueAutoMode());
  }
  resetAutoMode(): Promise<void> {
    return this.exclusive(() => this.deps.resetAutoMode());
  }
  // `async` is load-bearing on these two: requireMemoryDir() is resolved BEFORE the lock is taken (a
  // missing memory dir must not consume it), and an async method turns that synchronous throw into a
  // rejection. Without it these would throw past a caller holding only a `.catch()`, which is not
  // what a Promise-returning signature promises.
  async writeMemory(name: string, text: string, expectedModified?: string): Promise<{ modified: string }> {
    const dir = this.requireMemoryDir();
    return this.exclusive(async () => this.deps.writeMemory(dir, name, text, expectedModified));
  }
  async deleteMemory(name: string): Promise<void> {
    const dir = this.requireMemoryDir();
    return this.exclusive(async () => this.deps.deleteMemory(dir, name));
  }
  writeMemorySettings(patch: { autoMemoryEnabled?: boolean; autoMemoryDirectory?: string | null }): Promise<void> {
    return this.exclusive(async () => this.deps.writeMemorySettings(patch));
  }
}
