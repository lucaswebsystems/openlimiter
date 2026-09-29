"use client";

import { usePathname } from "next/navigation";
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
  const pathname = usePathname();

  useEffect(() => {
    const root = document.documentElement;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(`[${REVEAL_ATTR}]:not([${REVEALED_ATTR}])`),
    );

    const restoreTargets = () => {
      targets.forEach((target) => {
        target.style.removeProperty("opacity");
        target.style.removeProperty("transform");
        target.style.removeProperty("visibility");
        target.setAttribute(REVEALED_ATTR, "");
      });
    };

    const handBack = () => {
      root.removeAttribute(MOTION_ATTR);
      restoreTargets();
    };

    if (reducedMotion.matches || !("IntersectionObserver" in window)) {
      handBack();
      return;
    }

    /* The inline script normally arms the page before paint. Client navigation
       can arrive after that attribute was deliberately removed during cleanup,
       so rearm here before registering the new route's targets. */
    const armed = root.getAttribute(MOTION_ATTR);
    if (armed !== MOTION_ARMED && armed !== MOTION_LIVE) {
      root.setAttribute(MOTION_ATTR, MOTION_ARMED);
    }

    if (targets.length === 0) {
      root.removeAttribute(MOTION_ATTR);
      return;
    }
    root.setAttribute(MOTION_ATTR, MOTION_ARMED);
    let disposed = false;
    let release: (() => void) | undefined;

    const onMotionPreferenceChange = (event: MediaQueryListEvent) => {
      if (!event.matches) return;
      disposed = true;
      release?.();
      handBack();
    };
    reducedMotion.addEventListener("change", onMotionPreferenceChange);

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
          restoreTargets();
        };
      })
      .catch(() => handBack());

    /* Second failsafe. A page always has something in view, so if nothing at
       all has been reported by now the observer is not working and the page is
       handed straight back rather than left half painted. */
    const guard = window.setTimeout(() => {
      if (document.querySelector(`[${REVEALED_ATTR}]`) === null) {
        handBack();
      }
    }, MOTION_FAILSAFE_MS);

    return () => {
      disposed = true;
      window.clearTimeout(guard);
      release?.();
      reducedMotion.removeEventListener("change", onMotionPreferenceChange);
      handBack();
    };
  }, [pathname]);

  return null;
}
