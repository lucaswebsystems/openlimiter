import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "apps/desktop/ui/connections.js"),
  "utf8"
);

describe("desktop connection wiring", () => {
  it("renders native collector state and never schedules work during bootstrap", () => {
    expect(source).toMatch(
      /async function runRefresh\(record\)[\s\S]*backend\.refreshProvider\([\s\S]*normalizeCollectionOutcome/u
    );
    expect(source).toMatch(
      /async function bootstrap\(\)[\s\S]*await syncConnections\(\)[\s\S]*await syncCollectorStatus\(\)[\s\S]*render\(\)/u
    );
    expect(source).not.toMatch(
      /async function bootstrap\(\)[\s\S]*refreshDueConnections/u
    );
    expect(source).toContain('backend.listen(COLLECTOR_UPDATED_EVENT');
    expect(source).toMatch(
      /async function syncProviderDetections\(\)[\s\S]*backend\.listDetectedProviders\(\)[\s\S]*normalizeDetections/u
    );
  });

  it("dispatches catalogue refresh and diagnostics, and no click falls through", () => {
    expect(source).toMatch(/rowData\.action === connectionNextAction\.CONNECTED[\s\S]*await refreshNow\(record\)/u);
    expect(source).toMatch(/rowData\.action === connectionNextAction\.ERROR[\s\S]*diagnosticsTab\.click\(\)/u);
    /* Every state that is not connected or error resolves to the provider's
       own setup card, unconditionally, so a click can never be silently
       dropped. The old pin required a NOT_CONFIGURED guard here; that guard
       was the bug. */
    expect(source).not.toMatch(/connectionNextAction\.NOT_CONFIGURED && targetId/u);
    expect(source).toMatch(/setup shaped[\s\S]*if \(targetId\)[\s\S]*scrollIntoView/u);
    expect(source).toMatch(
      /rowData\.access === "automatic"[\s\S]*await syncProviderDetections\(\)[\s\S]*await syncConnections\(\)/u
    );
  });
});
