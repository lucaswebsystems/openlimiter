import { demoCapture } from "./cli-capture";

/**
 * The demo snapshot, parsed out of the real capture rather than retyped.
 *
 * Every number any product visual on this site displays is read from
 * `demoCapture.output` in lib/cli-capture.ts, which is verbatim stdout of
 * `openlimiter demo` against the project's synthetic fixtures. Nothing here
 * invents a row, rounds a figure, or reorders the table. If the capture is
 * ever retaken, every visual follows it automatically.
 *
 * The fixtures behind that capture are synthetic by construction, which is why
 * every surface rendering these rows also carries the demo data chip.
 */

export interface SnapshotRow {
  provider: string;
  meter: string;
  /** Percentage of the window consumed, 0 to 100, exactly as captured. */
  usagePercent: number;
  /** Freshness code from the core, for example `fresh`. */
  state: string;
  /** ISO instant the window resets, or null where the meter has no reset. */
  resetAt: string | null;
}

const HEADER = "PROVIDER METER USAGE STATE RESET";

/**
 * Splits the captured table into typed rows. A line that does not match the
 * shape the renderer emits is dropped rather than guessed at, so a malformed
 * capture produces fewer rows and never a wrong one.
 */
export function parseDemoRows(): readonly SnapshotRow[] {
  return demoCapture.output
    .split("\n")
    .filter((line) => line.length > 0 && line !== HEADER)
    .map((line): SnapshotRow | null => {
      const parts = line.split(" ");
      if (parts.length !== 5) return null;

      const [provider, meter, usage, state, reset] = parts;
      const percent = Number.parseFloat(usage.replace("PERCENT", ""));
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;

      return {
        provider,
        meter,
        usagePercent: percent,
        state,
        resetAt: reset === "NONE" ? null : reset,
      };
    })
    .filter((row): row is SnapshotRow => row !== null);
}

/** Sentence case for a captured enum, so `SEVEN_DAY` reads as `Seven day`. */
export function humanise(code: string): string {
  const words = code.toLowerCase().split("_");
  return words.map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" ");
}

/**
 * The worst meter per provider, which is what the statusline reports and what
 * a summary view should lead with.
 */
export function worstPerProvider(rows: readonly SnapshotRow[]): readonly SnapshotRow[] {
  const worst = new Map<string, SnapshotRow>();
  for (const row of rows) {
    const held = worst.get(row.provider);
    if (held === undefined || row.usagePercent > held.usagePercent) {
      worst.set(row.provider, row);
    }
  }
  return [...worst.values()];
}
