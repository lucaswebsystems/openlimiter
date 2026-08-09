"use client";

import { useEffect } from "react";
import {
  REVEAL_ARMED_ATTR,
  REVEAL_LIVE_ATTR,
  REVEAL_OBSERVER_TIMEOUT_MS,
  REVEAL_SHOWN_ATTR,
  REVEAL_TARGET_ATTR,
} from "@/lib/reveal";

/**
 * The only client component the reveal needs. It owns one IntersectionObserver
 * for every wrapper on the page and renders nothing.
 *
 * Two independent fail safes keep content from ever staying invisible: the
 * inline arming script disarms the hidden state if this controller never
 * mounts, and the timer below reveals everything if the observer never reports.
 */
export function RevealController() {
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute(REVEAL_LIVE_ATTR, "1");

    // Not armed means reduced motion, or a browser without the observer.
    // Content is already visible, so there is nothing to do.
    if (root.getAttribute(REVEAL_ARMED_ATTR) !== "1") {
      return () => {
        root.removeAttribute(REVEAL_LIVE_ATTR);
      };
    }

    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(`[${REVEAL_TARGET_ATTR}]`),
    );
    const show = (element: Element) => {
      element.setAttribute(REVEAL_SHOWN_ATTR, "1");
    };

    let observerReported = false;
    const observer = new IntersectionObserver(
      (entries) => {
        observerReported = true;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          show(entry.target);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );

    for (const target of targets) observer.observe(target);

    // A working observer reports on the frame after observe(). If it has not,
    // the mechanism is broken: show everything rather than hide the page.
    const failSafe = window.setTimeout(() => {
      if (observerReported) return;
      observer.disconnect();
      for (const target of targets) show(target);
    }, REVEAL_OBSERVER_TIMEOUT_MS);

    return () => {
      window.clearTimeout(failSafe);
      observer.disconnect();
      root.removeAttribute(REVEAL_LIVE_ATTR);
    };
  }, []);

  return null;
}
