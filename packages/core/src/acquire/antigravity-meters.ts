/**
 * The meter one status line bucket earns, from its id: `<pool>-5h` or
 * `<pool>-weekly`. Rust twin: `antigravity_meter` in native_readers.rs.
 *
 * The Google pool keeps FIVE_HOUR and SEVEN_DAY and the third party pool its
 * THIRD_PARTY codes, because every row already on disk carries them. Any other
 * pool is named after itself, so a new bucket is its own row and never aliases
 * the Gemini bars; a pool whose name cannot become a meter code is dropped.
 */
export function antigravityMeter(bucketId: string): { meter: string; durationSeconds: number } | null {
  const [, pool = "", period] = /^(.+)-(5h|weekly)$/u.exec(bucketId) ?? [];
  if (period === undefined) return null;
  const fiveHour = period === "5h";
  const named = pool === "gemini" ? null : pool === "3p" ? "THIRD_PARTY" : pool.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase();
  if (named !== null && !/^[A-Z]/u.test(named)) return null;
  return {
    meter: named === null ? (fiveHour ? "FIVE_HOUR" : "SEVEN_DAY") : named + (fiveHour ? "_SESSION" : "_WEEKLY"),
    durationSeconds: fiveHour ? 18_000 : 604_800
  };
}
