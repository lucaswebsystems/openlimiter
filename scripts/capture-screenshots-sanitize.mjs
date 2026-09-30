/** Capture inputs are synthetic. Reject identity shaped data before rendering. */
export function assertCaptureSafe(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(text) || /(?:[a-z]:[\\/]+users[\\/]|[\\/]home[\\/]|[\\/]Users[\\/])/iu.test(text)) {
    throw new Error("Capture refused: email or user profile path in fixture or rendered text.");
  }
  return value;
}

export function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Interpret only the colour escapes emitted by the real CLI band renderer. */
export function ansiHtml(text) {
  assertCaptureSafe(text);
  const colors = { "31": "red", "32": "green", "33": "yellow", "38;5;208": "orange" };
  let output = "", at = 0, open = false;
  for (const match of text.matchAll(/\x1b\[([\d;]*)m/gu)) {
    output += escapeHtml(text.slice(at, match.index));
    if (open) output += "</span>";
    const band = colors[match[1]];
    open = band !== undefined;
    if (open) output += `<span class="band-${band}">`;
    at = match.index + match[0].length;
  }
  output += escapeHtml(text.slice(at));
  if (open) output += "</span>";
  if (output.includes("\x1b")) throw new Error("Unsupported terminal escape in capture.");
  return output;
}

export function demoSessions(now) {
  return [
    ["claude_code", "waiting", 540], ["codex", "busy", 185], ["gemini_cli", "done", 420],
  ].map(([agent, state, elapsedSeconds], index) => ({
    sessionId: `capture-session-${index}`, agent, state, confidence: "explicit",
    firstObservedAt: new Date(Date.parse(now) - elapsedSeconds * 1000).toISOString(),
    observedAt: now, elapsedSeconds, computer: "local", outcome: null,
  }));
}
