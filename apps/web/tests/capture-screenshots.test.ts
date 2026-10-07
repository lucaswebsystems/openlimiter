// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error The repo uses jsdom without a separate declaration package.
import { JSDOM } from "jsdom";
// @ts-expect-error Capture scripts run directly in Node.
import { ansiHtml, assertCaptureSafe, demoSessions } from "../../../scripts/capture-screenshots-sanitize.mjs";
import { initialPairState, pairStateAfterClaim, pairStateAfterPoll } from "@/lib/pairing";
import { meterRowOf } from "@/lib/device-snapshots";
// @ts-expect-error Capture scripts run directly in Node.
import { demoSnapshots, edgeLayout, edgePage, edgeScene, edgeTabLayout, pairingCaptureResponse, terminalPage, windowPage } from "../../../scripts/capture-screenshots.mjs";

const now = "2026-09-28T12:00:00.000Z";

type CaptureSnapshot = {
  provider: string;
  meter: string;
  unit: string;
  value: number;
  currency?: string;
  resetAt?: string | null;
  observedAt?: string;
};

type CapturePhoneRow = {
  provider: string;
  amount: number | null;
  currency: string | null;
  [key: string]: unknown;
};

describe("synthetic screenshot pipeline", () => {
  it("waits for rendered provider card contents without the removed hero", () => {
    const source = readFileSync(new URL("../../../scripts/capture-screenshots.mjs", import.meta.url), "utf8");
    // The wait loops over the card's rendered parts inside the shadow card.
    expect(source).toContain('[".window-name", ".window-percent", ".window-reset"]');
    expect(source).toContain("firstCard.locator(selector)");
    expect(source).not.toContain(".ol-live-meter-card");
  });

  it("rejects emails and profile paths, including escaped JSON paths", () => {
    for (const value of ["demo@example.test", "C:\\Users\\example\\project", "/home/example/project", { path: "C:\\Users\\example" }]) {
      expect(() => assertCaptureSafe(value)).toThrow(/Capture refused/);
    }
    expect(assertCaptureSafe(demoSessions(now))).toHaveLength(3);
  });

  it("keeps the synthetic phone pairing claim in the waiting phase", () => {
    const expiresAt = "2026-10-01T12:02:00.000Z";
    const claimId = "00000000-0000-4000-8000-000000000002";
    const claim = pairingCaptureResponse({ action: "claim", code: "ABCD2345", device: { label: "Phone" } }, expiresAt);
    expect(claim).toEqual({ status: 200, body: { claim_id: claimId, expires_at: expiresAt } });
    const poll = pairingCaptureResponse({ action: "poll", claim_id: claimId }, expiresAt);
    expect(poll).toEqual({ status: 200, body: { status: "claimed" } });
    // Through the real parsers, the claim and then a poll leave the page waiting.
    const waiting = pairStateAfterClaim(initialPairState("code=ABCD2345"), claim.body, claim.status);
    expect(waiting.phase).toBe("waiting");
    expect(pairStateAfterPoll(waiting, poll.body, poll.status).phase).toBe("waiting");
    // A request outside the client's contract fails the capture.
    for (const request of [
      { action: "claim", code: "WRONG234", device: {} },
      { action: "claim", code: "ABCD2345" },
      { action: "claim", code: "ABCD2345", device: [] },
      { action: "poll" },
      { action: "poll", claim_id: "another" },
      { action: "approve" },
      null,
    ]) expect(pairingCaptureResponse(request, expiresAt)).toBeNull();
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
      for (const percentage of [42, 64, 69, 72, 94]) expect(line).toContain(`${percentage}%`);
      expect(line).toMatch(/^5h \[/u);
      expect(line).toContain("7d ");
      expect(line).toContain("fable7d ");
      expect(line).toContain("cx7d ");
      expect(line).toContain("ag5h ");
      for (const money of ["or $12.54", "oa $8.20", "an $3.10"]) expect(line).toContain(money);
      // Limits and money only, so the line keeps one row on a wide screen.
      expect(line).not.toContain("[?]");
      // A cell never breaks across lines: each one wraps as a whole.
      const cells = [...dom.window.document.querySelectorAll("pre > .cell")];
      expect(cells.map((cell) => cell.textContent)).toHaveLength(line.split(" | ").length);
      expect(cells.at(-1)?.textContent).not.toMatch(/\|\s*$/u);
      expect(cells.slice(1).every((cell) => cell.textContent?.startsWith(" | "))).toBe(true);
      if (theme === "light") {
        const styles = dom.window.document.querySelector("style")?.textContent ?? "";
        expect(styles).toContain(".band-yellow{color:#9a6700}");
        expect(styles).toContain(".band-orange{color:#bc4c00}");
        expect(styles).toContain(".band-red{color:#cf222e}");
      }
      dom.window.close();
    }
  });

  it("keeps every phone fixture row inside the phone wire contract", async () => {
    const snapshots = await demoSnapshots(now);
    const rows: CapturePhoneRow[] = snapshots.map((row: CaptureSnapshot) => ({
      account_id: "demo",
      provider: row.provider,
      code: row.meter,
      percent: row.unit === "PERCENT" ? Math.round(row.value) : null,
      amount: row.unit === "CREDITS" ? row.value : null,
      currency: row.unit === "CREDITS" ? row.currency ?? null : null,
      resets_at: row.resetAt ?? null,
      observed_at: row.observedAt ?? now,
      stale: false,
    }));
    expect(rows.every((row) => meterRowOf(row) !== null)).toBe(true);
    expect(rows.some((row) => row.provider === "OPENROUTER")).toBe(true);
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
    expect(edgeTabLayout(layout).view).toEqual({ left: -8, top: 679, width: 40, height: 60 });
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
