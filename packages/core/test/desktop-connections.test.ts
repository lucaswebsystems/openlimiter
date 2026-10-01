import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ui = (name: string): string =>
  readFileSync(resolve(process.cwd(), "apps/desktop/ui", name), "utf8");
const source = ui("connections.js");
const app = ui("app.js");
const readings = ui("readings.js");

describe("desktop connection wiring", () => {
  it("renders native collector state and never schedules work during bootstrap", () => {
    expect(source).toMatch(
      /async function refreshNow\(record\)[\s\S]*backend\.refreshProvider\([\s\S]*await syncConnections\(\)[\s\S]*normalizeCollectionOutcome/u
    );
    expect(source).toMatch(
      /async function bootstrap\(\)[\s\S]*await syncConnections\(\)[\s\S]*await detectClaude\(\)[\s\S]*render\(\)/u
    );
    const bootstrap = source.match(/async function bootstrap\(\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
    expect(bootstrap).not.toBe("");
    expect(bootstrap).not.toMatch(
      /refreshDueConnections|refreshNow|checkTool|refreshProvider|refreshHome|rescanDetectedProviders|setInterval|setTimeout/u
    );
    expect(source).toContain("backend.listen(COLLECTOR_UPDATED_EVENT");
    expect(source).toMatch(
      /export async function checkTool\(code\)[\s\S]*backend\.rescanDetectedProviders\(\)[\s\S]*backend\.refreshHome\(\[code\]\)/u
    );
  });

  it("dispatches catalogue refresh and inline diagnostics, and no click falls through", () => {
    /* Every catalogue row carries exactly one of two steps, and the two
       handlers app.js hands the renderer cover both, so no click is dropped. */
    expect(source).toMatch(/kind: "connect"[\s\S]*: \{ kind: "check"/u);
    expect(app).toMatch(
      /const catalogueHandlers = \{[\s\S]*connect: \(code\) => chooseTool\(code, "connect"\),[\s\S]*check: \(code\) => chooseTool\(code, "check"\),/u
    );
    expect(app).toMatch(/handlers: catalogueHandlers/u);
    expect(source).toMatch(
      /export async function chooseTool\(code, kind\)[\s\S]*kind === "connect" \? connectTool\(code\) : checkTool\(code\)/u
    );
    /* Every code ends in a step: Codex imports, setup tools open their panel
       (scrolled into view), and anything else falls to the read again check. */
    expect(source).toMatch(
      /export async function connectTool\(code\)[\s\S]*code === "CODEX"[\s\S]*if \(SETUP_TARGETS\[code\]\)[\s\S]*openSetup\(code\)[\s\S]*return checkTool\(code\)/u
    );
    expect(source).toMatch(/function openSetup\(code\)[\s\S]*scrollIntoView/u);
    /* Refresh: a connected tool's check re-reads its stored connections. */
    expect(source).toMatch(
      /export async function checkTool\(code\)[\s\S]*records\.map\(refreshNow\)/u
    );
    /* Inline diagnostics: a failing row names its issue and offers a connect
       or check step in place, and the row button routes to the matching one. */
    expect(readings).toMatch(/step\("check", "fixSignInAgainIssue"/u);
    expect(readings).toMatch(/step\("check", "fixOpenAppAction"/u);
    expect(app).toMatch(
      /route === "connect" \? connectTool\(tool\.code\) : checkTool\(tool\.code\)/u
    );
  });
});
