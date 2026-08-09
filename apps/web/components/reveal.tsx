"use client";

import { useEffect } from "react";
import {
  MOTION_ARMED,
  MOTION_ATTR,
  MOTION_FAILSAFE_MS,
  MOTION_LIVE,
  REVEALED_ATTR,
  REVEAL_ATTR,
} from "@/lib/motion";

/**
 * The one client component the motion system has.
 *
 * It renders nothing and it owns the single IntersectionObserver every reveal
 * on the site shares. It runs after hydration, which is the point: the observer
 * marks elements by setting an attribute on them, and doing that before React
 * has hydrated the server markup is a mismatch. The hidden start state is
 * armed earlier, before first paint, by the inline script in lib/motion.ts, so
 * waiting for this mount costs nothing visible.
 *
 * If this component never mounts, because the bundle failed or JavaScript threw
 * on the way here, the inline script's own timer removes the attribute and the
 * page shows in full. See lib/motion.ts for the whole contract.
 */
export function Reveal() {
  useEffect(() => {
    const root = document.documentElement;

    /* Not armed: reduced motion, no IntersectionObserver, or a failsafe has
       already handed the page back. Either way there is nothing to observe.
       Both armed values count, because this effect can run more than once (a
       development double mount, a fast refresh) and the previous run will have
       upgraded the value and then disconnected its own observer on cleanup. */
    const armed = root.getAttribute(MOTION_ATTR);
    if (armed !== MOTION_ARMED && armed !== MOTION_LIVE) return;

    const targets = Array.from(document.querySelectorAll(`[${REVEAL_ATTR}]`));
    if (targets.length === 0) {
      root.removeAttribute(MOTION_ATTR);
      return;
    }

    root.setAttribute(MOTION_ATTR, MOTION_LIVE);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute(REVEALED_ATTR, "");
          observer.unobserve(entry.target);
        }
      },
      /* Sixty pixels inside the bottom edge, the same trigger point paseo.sh
         uses, so an element starts its entrance just after it has cleared the
         fold rather than the instant its first pixel appears. Only the bottom
         edge is inset: insetting the top as well would hold back anything that
         loads already sitting above the fold. */
      { rootMargin: "0px 0px -60px 0px", threshold: 0 },
    );

    for (const target of targets) observer.observe(target);

    /* Second failsafe. A page always has something in view, so if nothing at
       all has been reported by now the observer is not working and the page is
       handed straight back rather than left half painted. */
    const guard = window.setTimeout(() => {
      if (document.querySelector(`[${REVEALED_ATTR}]`) === null) {
        root.removeAttribute(MOTION_ATTR);
      }
    }, MOTION_FAILSAFE_MS);

    return () => {
      window.clearTimeout(guard);
      observer.disconnect();
    };
  }, []);

  return null;
}
