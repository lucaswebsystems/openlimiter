/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
/**
 * The meter one status line bucket earns, from its id: `<pool>-5h` or
 * `<pool>-weekly`. Rust twin: `antigravity_meter` in native_readers.rs.
 *
 * The Google pool keeps FIVE_HOUR and SEVEN_DAY and the third party pool its
 * THIRD_PARTY codes, because every row already on disk carries them. Any other
 * pool keeps a readable name when that mapping is reversible. Other names,
 * including collisions with documented codes, use X_ and uppercase UTF8 hex.
 * Reserving X_ from readable names keeps the two namespaces disjoint. Codes
 * outside the normalizer's 32 character limit are dropped, never truncated.
 */
const reservedMeters = new Set([
  "FIVE_HOUR", "SEVEN_DAY", "THIRD_PARTY_SESSION", "THIRD_PARTY_WEEKLY"
]);

export function antigravityMeter(bucketId: string): { meter: string; durationSeconds: number } | null {
  const separator = bucketId.lastIndexOf("-");
  const pool = bucketId.slice(0, separator);
  const period = bucketId.slice(separator + 1).toLowerCase();
  if (separator <= 0 || !pool.isWellFormed() || (period !== "5h" && period !== "weekly")) return null;
  const fiveHour = period === "5h";
  const cadence = fiveHour ? "SESSION" : "WEEKLY";
  let meter: string;
  if (pool === "gemini") {
    meter = fiveHour ? "FIVE_HOUR" : "SEVEN_DAY";
  } else if (pool === "3p") {
    meter = `THIRD_PARTY_${cadence}`;
  } else {
    const named = pool.replace(/-/gu, "_").toUpperCase();
    meter = `${named}_${cadence}`;
    const readable = /^[a-z]/u.test(pool) && !/[^a-z0-9-]/u.test(pool);
    if (!readable || named.startsWith("X_") || reservedMeters.has(meter)) {
      const encoded = Array.from(new TextEncoder().encode(pool), byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
      meter = `X_${encoded}_${cadence}`;
    }
  }
  // Same complete code constraint as normalizer.ts, including the cadence.
  if (!/^[A-Z][A-Z0-9_]{0,31}$/u.test(meter)) return null;
  return {
    meter,
    durationSeconds: fiveHour ? 18_000 : 604_800
  };
}
