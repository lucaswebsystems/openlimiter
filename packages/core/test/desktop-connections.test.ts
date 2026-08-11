import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "apps/desktop/ui/connections.js"),
  "utf8"
);

describe("desktop connection wiring", () => {
  it("shares one serialized due refresh pass between bootstrap and ticks", () => {
    expect(source).toContain("let dueRefreshTail = Promise.resolve(false)");
    expect(source.match(/await refreshDueConnections\(/gu)).toHaveLength(2);
    expect(source).toMatch(/async function bootstrap\(\)[\s\S]*await syncConnections\(\)[\s\S]*await refreshDueConnections\([\s\S]*render\(\)/u);
    expect(source).toMatch(/function refreshDueConnections\(now\)[\s\S]*for \(const record of due\)[\s\S]*await runRefresh\(record\)/u);
  });

  it("dispatches catalogue refresh and diagnostics without setup scrolling", () => {
    expect(source).toMatch(/rowData\.action === connectionNextAction\.CONNECTED[\s\S]*await refreshNow\(record\)/u);
    expect(source).toMatch(/rowData\.action === connectionNextAction\.ERROR[\s\S]*diagnosticsTab\.click\(\)/u);
    expect(source).toMatch(/rowData\.action === connectionNextAction\.NOT_CONFIGURED && targetId/u);
  });
});
