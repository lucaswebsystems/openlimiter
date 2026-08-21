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

    const targets = Array.from(document.querySelectorAll<HTMLElement>(`[${REVEAL_ATTR}]`));
    if (targets.length === 0) {
      root.removeAttribute(MOTION_ATTR);
      return;
    }
    let disposed = false;
    let release: (() => void) | undefined;

    void Promise.all([import("gsap"), import("gsap/ScrollTrigger")])
      .then(([gsapModule, triggerModule]) => {
        if (disposed) return;
        const gsap = gsapModule.gsap;
        const ScrollTrigger = triggerModule.ScrollTrigger;
        gsap.registerPlugin(ScrollTrigger);
        root.setAttribute(MOTION_ATTR, MOTION_LIVE);

        const animations = targets.map((target) => {
          const travel = target.getAttribute(REVEAL_ATTR) === "sm" ? 12 : 20;
          const group = target.parentElement?.hasAttribute("data-reveal-group") === true
            ? target.parentElement
            : null;
          const order = group === null ? 0 : Array.from(group.children).indexOf(target);
          return gsap.fromTo(
            target,
            { autoAlpha: 0, y: travel },
            {
              autoAlpha: 1,
              y: 0,
              duration: 0.62,
              delay: Math.min(Math.max(order, 0) * 0.07, 0.35),
              ease: "power2.out",
              clearProps: "opacity,transform,visibility",
              onStart: () => target.setAttribute(REVEALED_ATTR, ""),
              scrollTrigger: {
                trigger: target,
                start: "top 88%",
                once: true,
              },
            },
          );
        });

        const pins = window.matchMedia("(min-width: 1024px)").matches
          ? Array.from(document.querySelectorAll<HTMLElement>("[data-scroll-pin]")).map(
              (target) =>
                ScrollTrigger.create({
                  trigger: target,
                  start: "center center",
                  end: "+=120",
                  pin: true,
                  pinSpacing: true,
                  anticipatePin: 1,
                }),
            )
          : [];

        release = () => {
          animations.forEach((animation) => animation.kill());
          pins.forEach((pin) => pin.kill());
        };
      })
      .catch(() => root.removeAttribute(MOTION_ATTR));

    /* Second failsafe. A page always has something in view, so if nothing at
       all has been reported by now the observer is not working and the page is
       handed straight back rather than left half painted. */
    const guard = window.setTimeout(() => {
      if (document.querySelector(`[${REVEALED_ATTR}]`) === null) {
        root.removeAttribute(MOTION_ATTR);
      }
    }, MOTION_FAILSAFE_MS);

    return () => {
      disposed = true;
      window.clearTimeout(guard);
      release?.();
    };
  }, []);

  return null;
}
