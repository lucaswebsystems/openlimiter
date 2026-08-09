"use client";

import { ArrowRight, GithubLogo } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { links } from "@/components/links";
import { DemoChip } from "@/components/ui";

const MeshGradient = dynamic(
  () => import("@paper-design/shaders-react").then((module) => module.MeshGradient),
  {
    loading: () => <div className="orb-fallback" />,
    ssr: false,
  },
);

function Orb() {
  const reduceMotion = Boolean(useReducedMotion());
  const [compact, setCompact] = useState(true);
  const [colors, setColors] = useState<string[] | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    setColors([
      styles.getPropertyValue("--color-shader-blue").trim(),
      styles.getPropertyValue("--color-shader-violet").trim(),
      styles.getPropertyValue("--color-shader-white").trim(),
      styles.getPropertyValue("--color-shader-navy").trim(),
    ]);
  }, []);

  const showShader = !reduceMotion && !compact && colors?.every(Boolean);

  return (
    <div className="orb-stage" aria-hidden="true">
      <div className="orb-glow" />
      <div className="orb-shell">
        {showShader && colors ? (
          <MeshGradient
            colors={colors}
            distortion={0.4}
            swirl={0.28}
            speed={0.1}
            style={{ width: "100%", height: "100%" }}
          />
        ) : (
          <div className="orb-fallback" />
        )}
      </div>
      <div className="orb-ring" />
    </div>
  );
}

export function Hero() {
  const reduceMotion = Boolean(useReducedMotion());
  const initial = reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24 };
  const transition = (delay: number) => ({
    duration: reduceMotion ? 0.2 : 0.7,
    delay: reduceMotion ? 0 : delay,
    ease: "easeOut" as const,
  });

  return (
    <section id="top" className="hero-section" aria-labelledby="hero-title">
      <div className="hero-stars" aria-hidden="true" />
      <div className="wide-container hero-content">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={transition(0)}
        >
          <Orb />
        </motion.div>

        <motion.p
          className="hero-kicker"
          initial={initial}
          animate={{ opacity: 1, y: 0 }}
          transition={transition(0.08)}
        >
          Open source prelaunch. Windows first. Cross platform.
        </motion.p>

        <motion.div
          className="hero-title-wrap"
          initial={initial}
          animate={{ opacity: 1, y: 0 }}
          transition={transition(0.16)}
        >
          <h1 id="hero-title">
            Know your limits. <span>Route around them.</span>
          </h1>
        </motion.div>

        <motion.p
          className="hero-copy"
          initial={initial}
          animate={{ opacity: 1, y: 0 }}
          transition={transition(0.24)}
        >
          OpenLimiter reads every AI subscription you hold and tells your coding
          agents which one still has budget, right inside their own context.
        </motion.p>

        <motion.div
          className="hero-actions"
          initial={initial}
          animate={{ opacity: 1, y: 0 }}
          transition={transition(0.32)}
        >
          <motion.a
            className="button button-primary"
            href={links.github}
            target="_blank"
            rel="noreferrer"
            whileHover={reduceMotion ? undefined : { y: -2 }}
            whileTap={reduceMotion ? undefined : { scale: 0.98 }}
          >
            <GithubLogo size={20} weight="regular" aria-hidden="true" />
            Star on GitHub
          </motion.a>
          <motion.a
            className="button button-ghost"
            href="#how-it-works"
            whileHover={reduceMotion ? undefined : { y: -2 }}
            whileTap={reduceMotion ? undefined : { scale: 0.98 }}
          >
            How it works
            <ArrowRight size={18} weight="regular" aria-hidden="true" />
          </motion.a>
        </motion.div>

        <motion.div
          className="status-strip"
          initial={initial}
          animate={{ opacity: 1, y: 0 }}
          transition={transition(0.4)}
          aria-label="Synthetic statusline example"
        >
          <div className="status-strip-top">
            <span className="terminal-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>openlimiter statusline</span>
            <DemoChip />
          </div>
          <code>
            <span className="status-good">CLAUDE 42%</span>
            <span className="status-warn">CODEX 81%</span>
            <span className="status-muted">GEMINI UNKNOWN</span>
            <span className="status-advice">ADVICE: PREFER CLAUDE</span>
          </code>
        </motion.div>
      </div>
    </section>
  );
}
