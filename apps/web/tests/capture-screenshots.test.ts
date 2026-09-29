// @vitest-environment node
import { describe, expect, it } from "vitest";
// @ts-expect-error The repo uses jsdom without a separate declaration package.
import { JSDOM } from "jsdom";
// @ts-expect-error Capture scripts run directly in Node.
import { ansiHtml, assertCaptureSafe, demoSessions } from "../../../scripts/capture-screenshots-sanitize.mjs";
// @ts-expect-error Capture scripts run directly in Node.
import { demoSnapshots, terminalPage, railPage, windowPage } from "../../../scripts/capture-screenshots.mjs";

const now = "2026-09-28T12:00:00.000Z";

describe("synthetic screenshot pipeline", () => {
  it("rejects emails and profile paths, including escaped JSON paths", () => {
    for (const value of ["demo@example.test", "C:\\Users\\example\\project", "/home/example/project", { path: "C:\\Users\\example" }]) {
      expect(() => assertCaptureSafe(value)).toThrow(/Capture refused/);
    }
    expect(assertCaptureSafe(demoSessions(now))).toHaveLength(3);
  });

  it("escapes terminal markup, preserves bands and rejects unsupported escapes", () => {
    expect(ansiHtml("\x1b[32m<script>\x1b[0m &")).toBe('<span class="band-green">&lt;script&gt;</span> &amp;');
    expect(() => ansiHtml("\x1b[2J")).toThrow(/Unsupported/);
  });

  it("renders the real CLI output in all four bands for each theme", async () => {
    const snapshots = await demoSnapshots(now);
    assertCaptureSafe(snapshots);
    for (const theme of ["dark", "light"]) {
      const dom = new JSDOM(await terminalPage(theme, snapshots, now));
      for (const band of ["green", "yellow", "orange", "red"]) expect(dom.window.document.querySelector(`.band-${band}`)?.textContent).toBeTruthy();
      for (const percentage of [42, 64, 84, 94]) expect(dom.window.document.querySelector("pre")?.textContent).toContain(`${percentage}%`);
      dom.window.close();
    }
  });

  it("feeds real desktop and Rail entry points only synthetic activity", async () => {
    const snapshots = await demoSnapshots(now);
    const sessions = demoSessions(now);
    const desktop = new JSDOM(await windowPage("dark", snapshots, sessions), { url: "http://localhost", runScripts: "dangerously" });
    const bridge = (desktop.window as unknown as { __TAURI__: { core: { invoke: (name: string) => Promise<unknown> } } }).__TAURI__.core;
    expect(await bridge.invoke("plugin:activity|activity_sessions")).toEqual(sessions);
    expect(JSON.parse(await bridge.invoke("read_cache") as string).snapshots).toHaveLength(10);
    desktop.window.close();
    const rail = new JSDOM(await railPage("light", sessions, now), { url: "http://localhost?unfolded", runScripts: "dangerously" });
    const railBridge = (rail.window as unknown as { __TAURI__: { core: { invoke: (name: string) => Promise<{ sessions: unknown; window: { unfolded: boolean } }> } } }).__TAURI__.core;
    const state = await railBridge.invoke("plugin:rail|rail_snapshot");
    expect(state.sessions).toEqual(sessions);
    expect(state.window.unfolded).toBe(true);
    expect(rail.window.document.querySelector('script[type="module"]')?.getAttribute("src")).toBe("rail.js");
    rail.window.close();
  });
});
