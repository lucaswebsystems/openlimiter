import { useEffect, useState } from "react";
import { offerCountdown, type OfferCountdown } from "./pro-trial";

/**
 * The offer's remaining time, ticking once a minute.
 *
 * ONE TICKER, TWO SURFACES
 * ------------------------
 * The hub's lock card and the Pro page's offer card both show the same
 * countdown, and both would otherwise have grown their own interval, their own
 * cleanup and their own answer to what happens at zero. It lives here instead,
 * so the two cannot disagree about the time left on the same offer.
 *
 * A MINUTE, NOT A SECOND
 * ----------------------
 * The smallest unit on screen is a minute, so a second by second render would
 * be fifty nine repaints nobody can see. The interval is aligned to the next
 * whole minute of the countdown rather than to the moment the component
 * mounted, which is why the number changes when the minute does.
 *
 * `frozen` is for a test, and for nothing else: passing a clock stops the
 * interval entirely and answers from that instant, so a fixture can assert a
 * countdown without waiting for one.
 */
export function useOfferCountdown(
  offerEndsAt: string | null,
  frozen?: number,
): OfferCountdown | null {
  const [now, setNow] = useState(() => frozen ?? Date.now());

  useEffect(() => {
    if (frozen !== undefined) return undefined;
    /* Land on the next whole minute, then keep to the minute after that. A
       countdown that ticks half a minute late is a countdown that skips. */
    const drift = 60_000 - (Date.now() % 60_000);
    let interval: number | null = null;
    const start = window.setTimeout(() => {
      setNow(Date.now());
      interval = window.setInterval(() => setNow(Date.now()), 60_000);
    }, drift);
    const onVisibilityChange = () => {
      setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(start);
      if (interval !== null) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [frozen]);

  return offerCountdown(offerEndsAt, frozen ?? now);
}
