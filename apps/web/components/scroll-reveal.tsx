"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function ScrollReveal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = root.current;
    if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const items = element.querySelectorAll<HTMLElement>("[data-reveal-item]");
    const targets = items.length > 0 ? Array.from(items) : [element];
    let cancelled = false;
    let safetyElapsed = false;
    let cancelReveal = () => {};
    let dispose = () => {};
    const safetyTimer = window.setTimeout(() => {
      safetyElapsed = true;
      cancelReveal();

      for (const target of targets) {
        target.style.opacity = "1";
        target.style.removeProperty("transform");
      }
    }, 1200);

    async function prepareReveal() {
      const [{ gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);

      if (cancelled || safetyElapsed || !element) {
        return;
      }

      gsap.registerPlugin(ScrollTrigger);
      const context = gsap.context(() => {
        gsap.fromTo(
          targets,
          { opacity: 0, y: 24 },
          {
            opacity: 1,
            y: 0,
            duration: 0.7,
            ease: "power2.out",
            stagger: 0.1,
            scrollTrigger: {
              trigger: element,
              start: "top 84%",
              once: true,
            },
          },
        );
      }, element);
      ScrollTrigger.refresh();

      cancelReveal = () => context.revert();
      dispose = () => {
        window.clearTimeout(safetyTimer);
        context.revert();
      };
    }

    void prepareReveal();

    return () => {
      cancelled = true;
      window.clearTimeout(safetyTimer);
      dispose();
    };
  }, []);

  return (
    <div ref={root} className={className}>
      {children}
    </div>
  );
}
