// @vitest-environment node
import { describe, expect, it } from "vitest";
// @ts-expect-error The repo uses jsdom without a separate declaration package.
import { JSDOM } from "jsdom";
// @ts-expect-error Capture scripts run directly in Node.
import { ansiHtml, assertCaptureSafe, demoSessions } from "../../../scripts/capture-screenshots-sanitize.mjs";
// @ts-expect-error Capture scripts run directly in Node.
import { demoSnapshots, edgeLayout, edgePage, edgeScene, pairingCaptureResponse, terminalPage, windowPage } from "../../../scripts/capture-screenshots.mjs";

const now = "2026-09-28T12:00:00.000Z";

describe("synthetic screenshot pipeline", () => {
  it("rejects emails and profile paths, including escaped JSON paths", () => {
    for (const value of ["demo@example.test", "C:\\Users\\example\\project", "/home/example/project", { path: "C:\\Users\\example" }]) {
      expect(() => assertCaptureSafe(value)).toThrow(/Capture refused/);
    }
    expect(assertCaptureSafe(demoSessions(now))).toHaveLength(3);
  });

  it("keeps the synthetic phone pairing claim in the waiting phase", () => {
    const expiresAt = "2026-10-01T12:02:00.000Z";
    expect(pairingCaptureResponse("claim", expiresAt)).toEqual({
      status: 200,
      body: {
        claim_id: "00000000-0000-4000-8000-000000000002",
        expires_at: expiresAt,
      },
    });
    expect(pairingCaptureResponse("poll", expiresAt)).toEqual({
      status: 200,
      body: { status: "claimed" },
    });
    expect(pairingCaptureResponse("approve", expiresAt)).toBeNull();
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
      for (const money of ["or $12.34", "oa $8.20", "an $3.10"]) expect(line).toContain(money);
      // Limits and money only, so the line keeps one row on a wide screen.
      expect(line).toMatch(/^5h \[/u);
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

  it("gives every demo agent its official mark, never a letter fallback", async () => {
    const dist = new URL("../../desktop/ui/dist/", import.meta.url);
    const names = await import(new URL("names.js", dist).href);
    const marks = await import(new URL("engine/ui/provider-row.js", dist).href);
    for (const { agent } of demoSessions(now)) {
      expect(String(marks.providerMarkMarkup(names.agentProvider(agent))), agent).toMatch(/^<svg/u);
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

  it("puts the mouse pointer on the open edge tab only", () => {
    const layout = edgeLayout(560);
    const open = new JSDOM(edgeScene("http://localhost", "dark", layout, true));
    const closed = new JSDOM(edgeScene("http://localhost", "dark", layout, false));
    expect(open.window.document.querySelector('svg[aria-hidden="true"] path[fill="#fff"]')).not.toBeNull();
    expect(closed.window.document.querySelector("svg")).toBeNull();
    open.window.close();
    closed.window.close();
  });
});
