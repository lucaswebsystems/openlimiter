import type { Forecast, Snapshot } from "./types.js";

export function forecast(previous: Snapshot, current: Snapshot): Forecast | null {
  if (
    previous.provider !== current.provider ||
    previous.meter !== current.meter ||
    previous.unit !== "PERCENT" ||
    current.unit !== "PERCENT" ||
    !Number.isFinite(previous.value) ||
    !Number.isFinite(current.value) ||
    previous.value < 0 ||
    previous.value > 100 ||
    current.value < 0 ||
    current.value > 100
  ) return null;
  const elapsedHours =
    (Date.parse(current.observedAt) - Date.parse(previous.observedAt)) / 3_600_000;
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) return null;
  const burnRatePerHour = (current.value - previous.value) / elapsedHours;
  if (!Number.isFinite(burnRatePerHour) || burnRatePerHour <= 0) return null;
  const remaining = Math.max(0, 100 - current.value);
  return {
    burnRatePerHour,
    hoursToExhaustion: remaining === 0 ? 0 : remaining / burnRatePerHour
  };
}
