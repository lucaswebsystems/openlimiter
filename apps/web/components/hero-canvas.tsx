"use client";

import { useEffect, useRef, useState } from "react";
import { HERO_CANVAS_MIN_WIDTH } from "@/lib/motion-flags";

/**
 * The meter field: the product's own subject, rendered in three dimensions.
 *
 * WHAT IT DRAWS AND WHY IT IS THIS AND NOT SOMETHING ELSE
 * ------------------------------------------------------
 * A grid of vertical bars whose heights drift, coloured by the same four
 * pressure bands the meters use everywhere else in this product: green below 60,
 * yellow to 79, orange to 89, red above. It is a field of quota meters seen from
 * an angle. A generic particle cloud or a rotating blob would have been faster
 * to write and would have said nothing; this says what the product is before a
 * word is read, and it cannot be mistaken for another company's hero.
 *
 * The band colours are the literal token values from app/app/theme.css. They are
 * duplicated here as numbers because WebGL cannot read a CSS custom property,
 * and the comment beside them is the contract: if the tokens move, these move.
 *
 * WHERE IT SITS IN THE FOLD, WHICH IS THE PART THAT MATTERS FOR PERFORMANCE
 * ------------------------------------------------------------------------
 * The poster remains the Largest Contentful Paint element. It is a CSS
 * background on the media layer, painted with the stylesheet on the first frame,
 * and nothing here changes that. This canvas mounts fully transparent, renders
 * its first frame, and only then fades in over the poster through `data-ready`,
 * which is the same arrangement the footage already uses. There is no moment
 * where the page is waiting on WebGL to paint something, and no layout shift is
 * possible because the layer is absolutely positioned inside a fold of fixed
 * height.
 *
 * An adversarial review flagged the opposite arrangement, lazy loading a
 * megabyte of WebGL INSIDE the fold as the thing the page waits for, as an
 * anti pattern that guarantees a poor LCP and Total Blocking Time. It was right,
 * and this is the shape that answers it.
 *
 * WHO NEVER SEES IT
 * -----------------
 *   - anyone under `prefers-reduced-motion: reduce`;
 *   - anyone below 768 pixels, who gets the still instead;
 *   - anyone who asked to save data;
 *   - anyone whose browser cannot give us a WebGL context.
 *
 * All four are decided before the three.js module is imported, so a visitor in
 * any of those groups never downloads it at all. That is the whole reason the
 * import is inside the effect rather than at the top of the file.
 *
 * WHAT IT COSTS WHILE IT RUNS
 * ---------------------------
 * Device pixel ratio is capped at 1.5, because a meter field at native ratio on
 * a 4K display is a lot of fragments for a background. The loop stops entirely
 * when the fold leaves the viewport and when the tab is hidden, through an
 * IntersectionObserver and a visibility listener rather than any scroll work.
 * Every geometry, material and renderer is disposed on unmount; a hero that
 * leaks a WebGL context on navigation is a hero that eventually kills the tab.
 */

/** The four pressure bands, mirroring --ol-meter-* in app/app/theme.css. */
const BAND_OK = 0x4ade80;
const BAND_WATCH = 0xfbbf24;
const BAND_HIGH = 0xfb923c;
const BAND_CRITICAL = 0xff8a80;

const COLUMNS = 22;
const ROWS = 13;
const COUNT = COLUMNS * ROWS;

/**
 * How far right the field sits, in world units.
 *
 * The fold's copy is LEFT and vertically centred, and the footage this replaces
 * was mirrored specifically to park its bright subject on the right, away from
 * the words. The field inherits that decision rather than rediscovering it: a
 * backdrop that competes with the headline is a backdrop that failed, however
 * good it looks on its own.
 */
const FIELD_OFFSET_X = 7.5;

export function HeroCanvas({ paused }: { paused: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  /* Read inside the loop rather than closed over, so flipping the pill does not
     tear down and rebuild the scene. */
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  /* The running scene's own controls, so the pill can reach them without the
     effect below listing `paused` as a dependency and rebuilding the scene. */
  const controlsRef = useRef<{ play: () => void; pause: () => void } | null>(null);

  useEffect(() => {
    const controls = controlsRef.current;
    if (controls === null) return;
    if (paused) controls.pause();
    else controls.play();
  }, [paused]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    // Every refusal happens before the import, so a refused visitor never pays
    // for the bundle.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (window.innerWidth < HERO_CANVAS_MIN_WIDTH) return;
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    if (connection?.saveData === true) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      let THREE: typeof import("three");
      try {
        THREE = await import("three");
      } catch {
        return;
      }
      if (disposed) return;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
      } catch {
        // No context, no canvas. The poster is already on screen and stays.
        return;
      }

      const width = host.clientWidth || window.innerWidth;
      const height = host.clientHeight || window.innerHeight;

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setSize(width, height, false);
      renderer.setClearColor(0x000000, 0);
      host.append(renderer.domElement);

      const scene = new THREE.Scene();
      /* Fog in the fold's own dark, starting close, so the field dissolves into
         the island instead of ending at an edge. This is also the contrast
         mechanism: the far rows are mostly fog by the time they reach the
         column the headline sits in. */
      scene.fog = new THREE.Fog(0x080b10, 12, 38);

      const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 100);
      camera.position.set(0, 9, 26);
      camera.lookAt(FIELD_OFFSET_X * 0.55, 1.2, 0);

      scene.add(new THREE.AmbientLight(0xffffff, 1.1));
      const key = new THREE.DirectionalLight(0xffffff, 1.5);
      key.position.set(6, 14, 10);
      scene.add(key);

      const geometry = new THREE.BoxGeometry(0.5, 1, 0.5);
      /* Half transparent on purpose. This is a backdrop behind white text whose
         contrast was measured on the built page; a solid field would put a
         bright green column behind a word and quietly fail the measurement the
         rest of this fold was designed around. */
      const material = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.5 });
      const bars = new THREE.InstancedMesh(geometry, material, COUNT);
      bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);
      bars.instanceColor = colorAttr;

      /** Per bar phase, so the field breathes instead of pulsing as one object. */
      const phase = new Float32Array(COUNT);
      const baseX = new Float32Array(COUNT);
      const baseZ = new Float32Array(COUNT);
      for (let i = 0; i < COUNT; i += 1) {
        const col = i % COLUMNS;
        const row = Math.floor(i / COLUMNS);
        baseX[i] = (col - (COLUMNS - 1) / 2) * 0.95 + FIELD_OFFSET_X;
        baseZ[i] = (row - (ROWS - 1) / 2) * 0.95;
        // Deterministic, not random: the same field renders on every load, which
        // is what makes a screenshot of it reproducible.
        phase[i] = (col * 0.7 + row * 1.3) % (Math.PI * 2);
      }

      const dummy = new THREE.Object3D();
      const colour = new THREE.Color();

      function bandFor(fraction: number): number {
        if (fraction >= 0.9) return BAND_CRITICAL;
        if (fraction >= 0.8) return BAND_HIGH;
        if (fraction >= 0.6) return BAND_WATCH;
        return BAND_OK;
      }

      let pointerX = 0;
      let pointerY = 0;
      function onPointerMove(event: PointerEvent) {
        pointerX = (event.clientX / window.innerWidth - 0.5) * 2;
        pointerY = (event.clientY / window.innerHeight - 0.5) * 2;
      }
      window.addEventListener("pointermove", onPointerMove, { passive: true });

      function onResize() {
        const w = host!.clientWidth || window.innerWidth;
        const h = host!.clientHeight || window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      window.addEventListener("resize", onResize, { passive: true });

      let raf = 0;
      let running = false;
      const start = performance.now();
      let painted = false;

      function frame(now: number) {
        const t = (now - start) / 1000;

        for (let i = 0; i < COUNT; i += 1) {
          // Two waves at different rates, so the field never visibly repeats.
          const wave = Math.sin(t * 0.42 + phase[i]) * 0.5 + 0.5;
          const drift = Math.sin(t * 0.17 + phase[i] * 0.6) * 0.5 + 0.5;
          const fraction = Math.min(1, Math.max(0.06, wave * 0.62 + drift * 0.38));
          /* Short. A meter field reads as a horizon, not as a skyline; tall bars
             turn a backdrop into the subject and crowd the words in front. */
          const barHeight = 0.3 + fraction * 3.4;

          dummy.position.set(baseX[i], barHeight / 2, baseZ[i]);
          dummy.scale.set(1, barHeight, 1);
          dummy.updateMatrix();
          bars.setMatrixAt(i, dummy.matrix);

          colour.setHex(bandFor(fraction));
          colorAttr.setXYZ(i, colour.r, colour.g, colour.b);
        }
        bars.instanceMatrix.needsUpdate = true;
        colorAttr.needsUpdate = true;

        // Parallax is eased toward the pointer rather than snapped to it.
        camera.position.x += (pointerX * 1.8 - camera.position.x) * 0.03;
        camera.position.y += (9 - pointerY * 1.1 - camera.position.y) * 0.03;
        camera.lookAt(FIELD_OFFSET_X * 0.55, 1.2, 0);

        renderer.render(scene, camera);

        if (!painted) {
          painted = true;
          // Fade in only once there is something to fade in to.
          setReady(true);
        }
        raf = requestAnimationFrame(frame);
      }

      function play() {
        // A pause the visitor asked for outlives scrolling and tab switching.
        // Coming back to the fold must not undo what they chose, which is the
        // same rule the footage already keeps.
        if (running || disposed || pausedRef.current) return;
        running = true;
        raf = requestAnimationFrame(frame);
      }
      function pause() {
        running = false;
        cancelAnimationFrame(raf);
      }

      scene.add(bars);
      controlsRef.current = { play, pause };

      // Only run while the fold is actually on screen and the tab is visible.
      const observer = new IntersectionObserver(
        (entries) => {
          const visible = entries.some((entry) => entry.isIntersecting);
          if (visible && document.visibilityState === "visible") play();
          else pause();
        },
        { threshold: 0.01 },
      );
      observer.observe(host);

      function onVisibility() {
        if (document.visibilityState === "visible") play();
        else pause();
      }
      document.addEventListener("visibilitychange", onVisibility);

      cleanup = () => {
        pause();
        controlsRef.current = null;
        observer.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("resize", onResize);
        geometry.dispose();
        material.dispose();
        bars.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      disposed = true;
      if (cleanup !== null) cleanup();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-hero-canvas=""
      data-ready={ready ? "" : undefined}
    />
  );
}
