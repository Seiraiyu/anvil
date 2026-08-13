import { runCcMicroQuery, type CcMicroQueryOpts } from "../cc/oneshot";

/**
 * Curated Material Symbols (Rounded) names. Constraining Sonnet's choice to this set
 * guarantees the returned name is a real, renderable icon (arch §5).
 */
const ICONS = [
  "bug_report", "build", "rocket_launch", "science", "experiment", "database", "storage",
  "lock", "key", "security", "login", "shield", "palette", "brush", "dashboard", "settings",
  "tune", "terminal", "code", "data_object", "cloud", "cloud_upload", "api", "hub", "schema",
  "account_tree", "network_node", "smartphone", "web", "language", "search", "bolt", "speed",
  "monitoring", "analytics", "insights", "healing", "cleaning_services", "integration_instructions",
  "payments", "shopping_cart", "mail", "notifications", "description", "article", "image",
  "photo_camera", "videocam", "mic", "map", "calendar_month", "chat", "forum", "person", "group",
  "memory", "sync", "auto_fix_high", "construction", "handyman", "flag", "bookmark", "label",
  "folder", "edit_document", "draft", "table_chart", "functions", "fingerprint", "support_agent",
];
const SET = new Set(ICONS);

/**
 * Ask Sonnet to pick the best-fitting icon for a session, constrained to ICONS. One-shot,
 * no tools (CLI-direct micro-query), uses the §3 OAuth env. Returns undefined on failure/timeout
 * so the caller falls back to a generic icon.
 */
export async function pickIcon(
  title: string,
  env: Record<string, string>,
  cc?: Pick<CcMicroQueryOpts, "ccCommand" | "extraEnv">,
): Promise<string | undefined> {
  const prompt =
    `Choose the single best-fitting icon for a software-development session titled: "${title}".\n` +
    `Pick exactly one name from this list:\n${ICONS.join(", ")}\n` +
    `Reply with ONLY the icon name (snake_case), nothing else.`;
  try {
    const text = await runCcMicroQuery(prompt, { model: "sonnet", env, timeoutMs: 20_000, ...cc });
    const name = text.trim().toLowerCase().replace(/[^a-z_]/g, "");
    return SET.has(name) ? name : undefined;
  } catch {
    return undefined;
  }
}
