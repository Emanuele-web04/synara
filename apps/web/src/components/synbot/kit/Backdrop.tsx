// FILE: Backdrop.tsx
// Purpose: HoloBot's dithered backdrop (ported from packages/ui src/Backdrop.tsx): grey Bayer
//          dots along the bottom of the pane it sits in, fading out by `DITHER.fade` of its
//          height. Dark only, as in HoloBot (the light page stays plain). One canvas pixel per
//          device pixel (crisp, never scaled), behind the pane's content, transparent between the
//          dots. Static: drawn once, again only when the pane's size or the screen's scale changes
//          (once the change settles).
// Layer: SynBot kit
// Exports: Backdrop

import { useEffect, useRef } from "react";

import { useTheme } from "~/hooks/useTheme";

import { DITHER, ditherBand } from "./dither";

function draw(canvas: HTMLCanvasElement) {
  const host = canvas.parentElement;
  if (!host) return;
  const scale = window.devicePixelRatio || 1;
  const width = Math.round(host.clientWidth * scale);
  const height = Math.round(Math.round(host.clientHeight * DITHER.fade) * scale);
  if (width === 0 || height === 0) return;
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width / scale}px`;
  canvas.style.height = `${height / scale}px`;
  const look = {
    luminance: DITHER.luminance,
    dot: DITHER.dot,
    coverage: DITHER.coverage,
    edge: DITHER.edge,
  };
  const pixels = new Uint8ClampedArray(ditherBand(width, height, look));
  canvas.getContext("2d")?.putImageData(new ImageData(pixels, width, height), 0, 0);
}

/** The dots under a pane (its parent must clip and stack its content above). */
export function Backdrop() {
  return useTheme().resolvedTheme === "dark" ? <Dither /> : null;
}

function Dither() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    // After the first paint: the pane shows its own surface until then.
    const frame = requestAnimationFrame(() => draw(canvas));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => draw(canvas), DITHER.settleMs);
    };
    const resize = new ResizeObserver(later);
    resize.observe(host);
    // Moving to a screen of another scale changes the device pixels, not always the size. The
    // query names one scale, so it is replaced by the new scale's each time it changes.
    let scale: MediaQueryList | null = null;
    const watchScale = () => {
      scale?.removeEventListener("change", onScale);
      scale = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      scale.addEventListener("change", onScale);
    };
    const onScale = () => {
      watchScale();
      later();
    };
    watchScale();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      resize.disconnect();
      scale?.removeEventListener("change", onScale);
    };
  }, []);
  return <canvas ref={ref} className="hb-backdrop" aria-hidden />;
}
