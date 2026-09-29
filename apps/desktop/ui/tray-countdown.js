/*
 * The tray's reset countdown. It lived in live-meter.js until that file was
 * removed (4e86883), which left tray.js importing a file that no longer
 * shipped; the tray window's start() then failed silently. Restored as the
 * one helper the tray uses.
 */
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The countdown, in the shape the design contract writes it: `03h 48m 12s`.
 *
 * A window more than a day out drops the seconds, because a person reading
 * "2d 06h" is not counting and a ticking second there is only noise.
 */
export function countdownText(resetAt, now) {
  if (resetAt === null || resetAt === undefined) return null;
  const target = typeof resetAt === "number" ? resetAt : Date.parse(resetAt);
  if (!Number.isFinite(target)) return null;
  const remaining = target - now;
  if (remaining <= 0) return "Resetting";
  if (remaining >= DAY) {
    const days = Math.floor(remaining / DAY);
    const hours = Math.floor((remaining % DAY) / HOUR);
    return String(days) + "d " + String(hours).padStart(2, "0") + "h";
  }
  const hours = Math.floor(remaining / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  const seconds = Math.floor((remaining % MINUTE) / SECOND);
  return (
    String(hours).padStart(2, "0") +
    "h " +
    String(minutes).padStart(2, "0") +
    "m " +
    String(seconds).padStart(2, "0") +
    "s"
  );
}
