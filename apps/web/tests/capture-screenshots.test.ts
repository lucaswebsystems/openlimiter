// @vitest-environment node
import { describe, expect, it } from "vitest";
// @ts-expect-error The repo uses jsdom without a separate declaration package.
import { JSDOM } from "jsdom";
// @ts-expect-error Capture scripts run directly in Node.
import { ansiHtml, assertCaptureSafe, demoSessions } from "../../../scripts/capture-screenshots-sanitize.mjs";
// @ts-expect-error Capture scripts run directly in Node.
import { demoSnapshots, edgeLayout, edgePage, terminalPage, windowPage } from "../../../scripts/capture-screenshots.mjs";

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

  it("renders the real Claude Code line in all four bands for each theme, without the folder or unknown cells", async () => {
    const snapshots = await demoSnapshots(now);
    assertCaptureSafe(snapshots);
    for (const theme of ["dark", "light"]) {
      const dom = new JSDOM(await terminalPage(theme, snapshots, now));
      for (const band of ["green", "yellow", "orange", "red"]) expect(dom.window.document.querySelector(`.band-${band}`)?.textContent).toBeTruthy();
      const line = dom.window.document.querySelector("pre")?.textContent ?? "";
      for (const percentage of [42, 64, 84, 94]) expect(line).toContain(`${percentage}%`);
      expect(line).toMatch(/^opus-5-5 high \| ctx 38% \| 5h \[/u);
      expect(line).not.toContain("[?]");
      // A cell never breaks across lines: each one wraps as a whole.
      expect([...dom.window.document.querySelectorAll("pre > .cell")].map((cell) => cell.textContent)).toHaveLength(line.split(" | ").length);
      dom.window.close();
    }
  });

  it("feeds the real desktop, edge tab and edge panel entry points only synthetic data", async () => {
    const snapshots = await demoSnapshots(now);
    const sessions = demoSessions(now);
    type Bridge = { __TAURI__: { core: { invoke: (name: string, args?: unknown) => Promise<unknown> } } };
    const desktop = new JSDOM(await windowPage("dark", snapshots, sessions), { url: "http://localhost", runScripts: "dangerously" });
    const bridge = (desktop.window as unknown as Bridge).__TAURI__.core;
    expect(await bridge.invoke("plugin:activity|activity_sessions")).toEqual(sessions);
    expect(JSON.parse(await bridge.invoke("read_cache") as string).snapshots).toHaveLength(10);
    desktop.window.close();
    for (const entry of ["edge-tab", "edge-panel"]) {
      const edge = new JSDOM(await edgePage(entry, "light", snapshots, sessions), { url: `http://localhost/${entry}-light?open`, runScripts: "dangerously" });
      const edgeBridge = (edge.window as unknown as Bridge).__TAURI__.core;
      const state = await edgeBridge.invoke("plugin:rail|rail_snapshot") as { sessions: unknown; window: { cardOpen: boolean } };
      expect(state.sessions).toEqual(sessions);
      expect(state.window.cardOpen).toBe(true);
      expect(JSON.parse(await edgeBridge.invoke("read_cache") as string).snapshots).toHaveLength(10);
      await edgeBridge.invoke("plugin:rail|rail_card_height", { height: 480 });
      expect((edge.window as unknown as { __heights: number[] }).__heights).toEqual([480]);
      expect(edge.window.document.querySelector('script[type="module"]')?.getAttribute("src")).toBe(`${entry}.js`);
      edge.window.close();
    }
  });

  it("places the edge tab and panel by the product's rule and refuses a panel that would scroll", () => {
    // 70% down a 982 pixel work area; a 560 pixel panel moves up to stay inside it.
    const layout = edgeLayout(560);
    expect(layout.tab).toEqual({ left: 0, top: 687, width: 24, height: 44 });
    expect(layout.panel).toEqual({ left: 28, top: 422, width: 360, height: 560 });
    expect(layout.view).toEqual({ left: 0, top: 422, width: 560, height: 560 });
    // A short panel keeps its top level with the tab's, and never shrinks below 160.
    expect(edgeLayout(100).panel).toEqual({ left: 28, top: 687, width: 360, height: 160 });
    for (const natural of [884, Number.NaN, 0]) expect(() => edgeLayout(natural)).toThrow(/not captured/);
  });
});
