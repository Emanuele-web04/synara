// FILE: FitStage.tsx
// Purpose: Lays an onboarding illustration out on a fixed design canvas and scales it down
//          (never up) to fit the stage, so the composition keeps its proportions on any
//          window size instead of reflowing.
// Layer: Web UI layout primitive

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export function FitStage(props: {
  /** Design canvas size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** `bottom` pins the canvas to the stage's bottom edge (devices rising out of it). */
  readonly align?: "center" | "bottom";
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { width, height, align = "center" } = props;
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => {
      const next = Math.min(1, frame.clientWidth / width, frame.clientHeight / height);
      setScale(Number.isFinite(next) && next > 0 ? next : 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [width, height]);

  return (
    <div ref={frameRef} className={cn("relative size-full overflow-hidden", props.className)}>
      <div
        className={cn(
          "absolute left-1/2",
          align === "center" ? "top-1/2 origin-center" : "bottom-0 origin-bottom",
        )}
        style={{
          width,
          height,
          transform: `translate(-50%, ${align === "center" ? "-50%" : "0"}) scale(${scale})`,
        }}
      >
        {props.children}
      </div>
    </div>
  );
}
