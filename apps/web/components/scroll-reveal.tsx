import type { ReactNode } from "react";
import { REVEAL_MAX_STEP } from "@/lib/reveal";

interface ScrollRevealProps {
  children: ReactNode;
  className?: string;
  /**
   * Stagger position on the shared reveal scale, 0 to REVEAL_MAX_STEP.
   * Each step adds 50ms of delay. Values outside the scale are clamped.
   */
  step?: number;
}

/**
 * Server rendered reveal wrapper. It ships no JavaScript of its own: the
 * markup carries data attributes, globals.css owns the transition, and one
 * shared observer in RevealController flips the shown state.
 */
export function ScrollReveal({ children, className, step = 0 }: ScrollRevealProps) {
  const clampedStep = Math.min(Math.max(Math.trunc(step), 0), REVEAL_MAX_STEP);

  return (
    <div data-reveal="" data-reveal-step={clampedStep} className={className}>
      {children}
    </div>
  );
}
