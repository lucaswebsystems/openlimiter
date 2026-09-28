/** Session details are display only and must never be persisted in quota state. */
export interface StatuslineSession {
  model?: string;
  effort?: string;
  dir?: string;
  ctx?: number;
  style?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Host metadata must not inject terminal controls or additional status rows.
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return clean || undefined;
}

export function parseStatuslineSession(payload: unknown): StatuslineSession {
  const root = record(payload);
  const model = record(root["model"]);
  const name = text(model["display_name"]) ?? text(model["id"]) ?? text(root["model"]);
  const effort = text(record(root["effort"])["level"]) ?? text(root["effort"]);
  const directory = text(record(root["workspace"])["current_dir"]) ?? text(root["cwd"]);
  const context = record(root["context_window"])["used_percentage"];
  const style = text(record(root["output_style"])["name"]);
  return {
    ...(name ? { model: name.replace(/^Claude\s+/i, "").replace(/\s*(\([^()]*\)|\[[^\[\]]*\])\s*$/, "").trim().toLowerCase().replace(/[\s.]+/g, "-") } : {}),
    ...(effort ? { effort } : {}),
    ...(directory ? { dir: directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? directory } : {}),
    ...(typeof context === "number" && Number.isFinite(context) && context >= 0 ? { ctx: context } : {}),
    ...(style && style.toLowerCase() !== "default" ? { style } : {})
  };
}
