// FILE: OnboardingAsciiBackdrop.tsx
// Purpose: The character-built landscape behind the first-run onboarding, shared with the
//          trysynara.com hero. Four layered SVGs per theme are decoded off-thread and
//          revealed together, so the artwork never paints layer by layer.
// Layer: Web UI decoration (aria-hidden, pointer-events none)

import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

const THEMES = ["light", "dark"] as const;
const LAYERS = [0, 1, 2, 3] as const;
type Theme = (typeof THEMES)[number];

export function OnboardingAsciiBackdrop(props: { className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState<Record<Theme, boolean>>({ light: false, dark: false });

  useEffect(() => {
    let disposed = false;
    const decoded: Record<Theme, Set<HTMLImageElement>> = { light: new Set(), dark: new Set() };
    const images = Array.from(root.current?.querySelectorAll<HTMLImageElement>("img") ?? []);
    const cleanups = images.map((image) => {
      const revealWhenDecoded = async () => {
        try {
          await image.decode();
        } catch {
          // Keep incomplete artwork hidden if a layer fails to load.
          return;
        }
        if (disposed) return;
        const theme = image.dataset.theme as Theme;
        decoded[theme].add(image);
        if (decoded[theme].size === LAYERS.length) {
          setReady((previous) => ({ ...previous, [theme]: true }));
        }
      };
      image.addEventListener("load", revealWhenDecoded, { once: true });
      // Cached images can finish before the listener attaches.
      if (image.complete && image.naturalWidth > 0) void revealWhenDecoded();
      return () => image.removeEventListener("load", revealWhenDecoded);
    });
    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  return (
    <div
      ref={root}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden select-none",
        props.className,
      )}
    >
      <div className="absolute bottom-0 left-1/2 aspect-video w-[max(100%,1600px)] -translate-x-1/2 [mask-image:linear-gradient(to_bottom,transparent_0%,#000_28%)] dark:opacity-85">
        {THEMES.map((theme) => (
          <div
            key={theme}
            data-ready={ready[theme]}
            className={cn(
              "absolute inset-0 opacity-0 transition-opacity duration-700 ease-out data-[ready=true]:opacity-100 motion-reduce:transition-none",
              theme === "light" ? "block dark:hidden" : "hidden dark:block",
            )}
          >
            {LAYERS.map((layer) => (
              // Lazy images load only the visible theme (the other one is display: none).
              <img
                key={layer}
                data-theme={theme}
                src={`/onboarding/hero-ascii-${theme}-${layer}.svg`}
                width={1600}
                height={900}
                alt=""
                decoding="async"
                loading="lazy"
                draggable={false}
                className="absolute inset-x-0 top-0 h-auto w-full"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
