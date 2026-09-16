import { useEffect } from "react";

/**
 * Moves the highlight of the surface under the pointer. Positions are written
 * through CSSOM custom properties (`--sheen-x`, `--sheen-y`), which a
 * `style-src 'self'` policy permits. Purely decorative; reads no app state.
 */
export function useSurfaceSheen(selector: string): void {
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) return;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const surface = event.target.closest<HTMLElement>(selector);
      if (surface === null) return;
      const { clientX, clientY } = event;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = surface.getBoundingClientRect();
        surface.style.setProperty("--sheen-x", `${clientX - rect.left}px`);
        surface.style.setProperty("--sheen-y", `${clientY - rect.top}px`);
      });
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", onMove);
    };
  }, [selector]);
}
