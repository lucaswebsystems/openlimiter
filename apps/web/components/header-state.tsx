"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * The header's one piece of state, watched rather than scrolled.
 *
 * The sticky header has three treatments, and CSS in globals.css draws all of
 * them from a single attribute this component writes on the header element:
 *
 *   data-bar="none"   the transparent state: the header sits within the fold's
 *                     top scrim band, the one region measured to hold white
 *                     text on any frame, so there is no bar at all;
 *   data-bar="dark"   everywhere else that any part of the fold is on screen:
 *                     the frosted coat is up and stays dark whatever the theme
 *                     says, because a light frosted coat over footage is murk;
 *   data-bar="page"   past the fold: the frosted bar in the page's own theme.
 *
 * With NO attribute, CSS shows the safe frosted themed bar. That is the truth
 * for every page without a fold, and the pre hydration truth a fold page
 * corrects with the inline sync script in components/hero.tsx before first
 * paint; this component takes over from that script on mount.
 *
 * Two IntersectionObservers, no scroll listener, no rootMargin anywhere. The
 * first watches the fold's top sentinel, a marker exactly one bar height tall
 * whose size follows the --ol-header-h token across the breakpoint, so the
 * transparent boundary can never go stale when the bar changes height. The
 * second watches the fold against the plain viewport, which is what separates
 * "dark" from "page". The initial state is computed synchronously from real
 * geometry, so no frame ever shows a guessed default, and a load restored mid
 * page starts correct even before an observer has fired.
 *
 * The pathname is a dependency on purpose: the header lives in the root
 * layout and survives client side navigation, so the effect re runs on every
 * route change, re queries the fold, and either watches the new one or pins
 * the themed bar. WebKit's back forward cache restores the page with the old
 * attribute frozen in the DOM; pageshow with persisted true is that restore,
 * and it re measures.
 */
export function HeaderState() {
  const pathname = usePathname();

  useEffect(() => {
    /* The pre hydration bridge in hero.tsx hands its scroll listener over. */
    const bridge = (window as Window & { __olFoldPreSync?: () => void }).__olFoldPreSync;
    if (typeof bridge === "function") bridge();

    const header = document.querySelector<HTMLElement>(".site-header");
    if (header === null) return undefined;

    const fold = document.querySelector<HTMLElement>(".hero-fold");
    const sentinel = document.querySelector<HTMLElement>(".hero-fold-sentinel");
    if (fold === null || sentinel === null) {
      header.setAttribute("data-bar", "page");
      return () => header.removeAttribute("data-bar");
    }

    const measure = () => {
      const r = fold.getBoundingClientRect();
      const barH = header.getBoundingClientRect().height || 56;
      return { atTop: r.top > -barH, onScreen: r.bottom > 0 };
    };

    let { atTop, onScreen } = measure();
    const apply = () => {
      header.setAttribute("data-bar", atTop ? "none" : onScreen ? "dark" : "page");
    };
    apply();

    const topEdge = new IntersectionObserver(
      ([entry]) => {
        if (entry === undefined) return;
        atTop = entry.isIntersecting;
        apply();
      },
      { threshold: 0 },
    );
    const viewport = new IntersectionObserver(
      ([entry]) => {
        if (entry === undefined) return;
        onScreen = entry.isIntersecting;
        apply();
      },
      { threshold: 0 },
    );
    topEdge.observe(sentinel);
    viewport.observe(fold);

    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      ({ atTop, onScreen } = measure());
      apply();
    };
    window.addEventListener("pageshow", onPageShow);

    return () => {
      topEdge.disconnect();
      viewport.disconnect();
      window.removeEventListener("pageshow", onPageShow);
      header.removeAttribute("data-bar");
    };
  }, [pathname]);

  return null;
}
