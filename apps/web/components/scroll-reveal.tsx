"use client";

import { motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";

interface ScrollRevealProps {
  children: ReactNode;
  className?: string;
  delay?: number;
}

export function ScrollReveal({ children, className = "", delay = 0 }: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [isFallback, setIsFallback] = useState(false);

  useEffect(() => {
    setMounted(true);

    const isReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (isReduced) {
      setPrefersReducedMotion(true);
      setShown(true);
      return;
    }

    const el = ref.current;
    if (!el) {
      setShown(true);
      return;
    }

    // Check if element is at or near top of viewport on mount
    const rect = el.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 800;
    if (rect.top < viewportHeight + 100) {
      setShown(true);
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "50px 0px 50px 0px" },
    );
    io.observe(el);

    // Fail safe fallback: force visibility within ~800ms if trigger does not fire
    const fallback = setTimeout(() => {
      setIsFallback(true);
      setShown(true);
      io.disconnect();
    }, 800);

    return () => {
      io.disconnect();
      clearTimeout(fallback);
    };
  }, []);

  if (!mounted || prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
      transition={{
        duration: isFallback ? 0.3 : 0.4,
        delay: isFallback ? 0 : delay,
        ease: [0.21, 0.47, 0.32, 0.98],
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
