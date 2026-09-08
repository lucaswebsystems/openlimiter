/** Shared with the desktop's pool identities. Unknown pools never alias Gemini. */
export function antigravityMeter(bucketId: string, window?: string): { meter: string; durationSeconds: number } | null {
  const pool = bucketId === "gemini" || bucketId.startsWith("gemini-") ? "gemini" :
    bucketId === "3p" || bucketId.startsWith("3p-") ? "3p" : null;
  const period = window ?? (bucketId.endsWith("-5h") ? "5h" : bucketId.endsWith("-weekly") ? "weekly" : "");
  if (pool === null || (period !== "5h" && period !== "weekly")) return null;
  return {
    meter: pool === "gemini" ? (period === "5h" ? "FIVE_HOUR" : "SEVEN_DAY") :
      (period === "5h" ? "THIRD_PARTY_SESSION" : "THIRD_PARTY_WEEKLY"),
    durationSeconds: period === "5h" ? 18_000 : 604_800
  };
}
