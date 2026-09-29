import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshEnvironment(profile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Keep the harness write guard and OS process settings, without inheriting
  // provider configuration, credentials, or terminal capability overrides.
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|NODE_OPTIONS|OPENLIMITER_TEST_SANDBOX)$/i.test(key)) {
      env[key] = value;
    }
  }
  for (const key of [
    "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TMP", "TEMP", "TMPDIR",
    "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR", "XDG_CONFIG_DIRS", "XDG_DATA_DIRS",
    ...Object.keys(process.env).filter((key) => key.startsWith("XDG_"))
  ]) env[key] = profile;
  env["TERM"] = "xterm-256color";
  env["LC_ALL"] = "C.UTF-8";
  return env;
}

describe("built statusline entry on a fresh install", () => {
  it.each([
    { noColor: true, used: 18, band: 32, bar: "█░░░░░░░░░" },
    { noColor: false, used: 18, band: 32, bar: "█░░░░░░░░░" },
    { noColor: false, used: 65, band: 33, bar: "██████░░░░" },
    { noColor: false, used: 85, band: "38;5;208", bar: "████████░░" },
    { noColor: false, used: 95, band: 31, bar: "█████████░" }
  ])("renders real stdin with NO_COLOR=$noColor, usage=$used", ({ noColor, used, band, bar }) => {
    const root = mkdtempSync(path.join(realpathSync(tmpdir()), "openlimiter-statusline-entry-"));
    roots.push(root);
    const profile = path.join(root, "profile");
    mkdirSync(profile);
    const env = freshEnvironment(profile);
    if (noColor) env["NO_COLOR"] = "1";
    expect(readdirSync(profile)).toEqual([]);

    // Keep the real clock. Thirty seconds of headroom makes the displayed
    // reset durations stable for the child's bounded ten second lifetime.
    const now = Math.floor(Date.now() / 1000);
    const input = path.join(root, "stdin.json");
    const output = path.join(root, "stdout.txt");
    const errors = path.join(root, "stderr.txt");
    writeFileSync(input, JSON.stringify({
      model: { display_name: "Opus 5.5" },
      effort: { level: "high" },
      workspace: { current_dir: "C:\\work\\project" },
      context_window: { used_percentage: 31 },
      rate_limits: {
        five_hour: { used_percentage: used, resets_at: now + 3 * 3600 + 20 * 60 + 30 },
        seven_day: { used_percentage: 27, resets_at: now + 4 * 86400 + 2 * 3600 + 30 }
      }
    }));
    // File descriptors exercise the same stdin path as shell redirection and
    // avoid named pipes, which some Windows sandboxes deny with EPERM.
    const fds: number[] = [];
    try {
      fds.push(openSync(input, "r"), openSync(output, "w"), openSync(errors, "w"));
      const result = spawnSync(process.execPath, [
        "packages/cli/dist/bin.js", "statusline", "--host", "claude"
      ], { cwd: process.cwd(), env, stdio: fds, windowsHide: true, timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
    } finally {
      for (const fd of fds) closeSync(fd);
    }
    const paint = (text: string, code: number | string): string =>
      noColor ? text : `\x1b[${code}m${text}\x1b[0m`;
    expect(readFileSync(errors, "utf8")).toBe("");
    expect(readFileSync(output, "utf8")).toBe(
      "opus-5-5 high | ctx 31% | 5h " +
      paint(`[${bar}]`, band) + " " + paint(`${used}%`, band) + " ·3h20m | 7d " +
      paint("[██░░░░░░░░]", 32) + " " + paint("27%", 32) + " ·4d2h\n"
    );
  });
});
