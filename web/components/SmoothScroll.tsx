"use client";

import { useEffect, type ReactNode } from "react";
import { registerLenis } from "@/lib/navigation";

/**
 * Lenis smooth scrolling, wired to GSAP's ticker.
 *
 * Two details here are load-bearing:
 *
 *  - `autoRaf: false` plus driving `lenis.raf()` from `gsap.ticker`. If Lenis
 *    runs its own requestAnimationFrame loop while GSAP runs another, the two
 *    advance on different frames and scrolling visibly jitters.
 *  - `lenis.on("scroll", ScrollTrigger.update)`. Lenis drives the real scroll
 *    position, so ScrollTrigger has to be told to re-evaluate on every smoothed
 *    frame or its progress lags behind by a frame.
 *
 * This renders a fragment rather than a wrapper element on purpose. ScrollTrigger
 * pins the gallery with a transform, and any transformed ancestor becomes the
 * containing block for the fixed WebGL canvas, which would break it.
 *
 * Both libraries are imported dynamically so that nothing touches `window` during
 * server rendering.
 */
export default function SmoothScroll({ children }: { children: ReactNode }) {
  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Respect the preference: fall back to native scrolling entirely. The
    // navigation helpers degrade to window.scrollTo in that case.
    if (reducedMotion) return;

    let disposed = false;
    let teardown: (() => void) | undefined;

    void (async () => {
      const [{ default: gsap }, { ScrollTrigger }, { default: Lenis }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
        import("lenis"),
      ]);
      if (disposed) return;

      gsap.registerPlugin(ScrollTrigger);

      const lenis = new Lenis({
        autoRaf: false,
        lerp: 0.09,
        wheelMultiplier: 1,
        touchMultiplier: 1.4,
      });

      const onScroll = () => ScrollTrigger.update();
      lenis.on("scroll", onScroll);

      const tick = (time: number) => {
        // gsap.ticker reports seconds; lenis.raf expects milliseconds.
        lenis.raf(time * 1000);
      };
      gsap.ticker.add(tick);
      // Without this, GSAP smooths over long frames and Lenis jumps on wake.
      gsap.ticker.lagSmoothing(0);

      registerLenis(lenis);

      teardown = () => {
        registerLenis(null);
        gsap.ticker.remove(tick);
        lenis.off("scroll", onScroll);
        lenis.destroy();
      };
    })();

    return () => {
      disposed = true;
      teardown?.();
    };
  }, []);

  return <>{children}</>;
}
