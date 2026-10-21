import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// readings.js reaches the compiled engine, which only exists in the build.
import { alertBatchNote, alertSamples } from "./dist/readings.js";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const now = new Date(NOW).toISOString();
const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const row = (provider, value) => ({
  provider, accountId: "default", meter: "MONTHLY", unit: "PERCENT", value,
  observedAt: new Date(NOW - 60_000).toISOString(),
  expiresAt: new Date(NOW + 600_000).toISOString(),
  resetAt: new Date(NOW + 86_400_000).toISOString(),
});

/* 2.1.8: a Cursor sample failed native validation, the whole batch went with
   it and the caller never looked, so no provider raised any alert. */
test("a Cursor row still yields an alert batch beside the other providers", () => {
  const samples = alertSamples([row("CURSOR", 85), row("CLAUDE", 85)], now);
  assert.deepEqual(samples.map((sample) => sample.provider), ["CURSOR", "CLAUDE"]);
  assert.equal(samples[0].meter, "provider_usage_percent");
});

test("skipped samples and a refused batch are logged, never ignored", () => {
  assert.equal(alertBatchNote({ ok: true, value: { events: [], skipped: 0, skipReasons: [] } }), null);
  assert.equal(
    alertBatchNote({ ok: true, value: { events: [], skipped: 2, skipReasons: ["unknown_provider", "invalid_value"] } }),
    "Alerts skipped 2 samples: unknown_provider, invalid_value.",
  );
  assert.equal(
    alertBatchNote({ ok: false, reason: "command_failed", message: "invalid_input" }),
    "Alerts could not be evaluated: invalid_input.",
  );
  /* A static serve of the window has no native side to refuse anything. */
  assert.equal(alertBatchNote({ ok: false, reason: "backend_absent" }), null);
  /* The caller hands the result to the note and logs it. */
  assert.match(
    read("./app.js"),
    /const alertNote = alertBatchNote\(await evaluateNotifications\(notificationSamples\)\);\s*if \(alertNote !== null\) console\.warn\(alertNote\);/u,
  );
  /* The native batch reports what it skipped under the names read above. */
  assert.match(read("../src-tauri/src/notifications.rs"), /pub struct NotificationBatch \{\s*events: [^,]+,\s*skipped: usize,\s*skip_reasons: /u);
});
