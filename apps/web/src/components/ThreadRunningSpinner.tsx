import { useRef } from "react";

import { useTimelineSynchronizedAnimations } from "~/lib/animationTimelineSync";
import { cn } from "~/lib/utils";

// stepped animate-spin-stepped token, not animate-spin: the glyph is always on while a thread runs and a continuous 60fps spin forced the backdrop-filtered sidebar + window vibrancy to re-render every frame; pinned to document timeline so N threads step in the same frame
const CANVAS = 15;
const LINE_WIDTH = 2;
const RADIUS = (CANVAS - LINE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const ARC_LENGTH = (0.72 - 0.16) * CIRCUMFERENCE;

export function ThreadRunningSpinner({ className }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  useTimelineSynchronizedAnimations(svgRef);
  return (
    <svg
      ref={svgRef}
      aria-hidden="true"
      viewBox={`0 0 ${CANVAS} ${CANVAS}`}
      fill="none"
      className={cn(
        "inline-block size-3 shrink-0 animate-spin-stepped text-muted-foreground/55 motion-reduce:animate-none",
        className,
      )}
    >
      <circle
        cx={CANVAS / 2}
        cy={CANVAS / 2}
        r={RADIUS}
        stroke="currentColor"
        strokeOpacity={0.22}
        strokeWidth={LINE_WIDTH * 0.7}
      />
      <circle
        cx={CANVAS / 2}
        cy={CANVAS / 2}
        r={RADIUS}
        stroke="currentColor"
        strokeWidth={LINE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={`${ARC_LENGTH} ${CIRCUMFERENCE}`}
        strokeDashoffset={-0.16 * CIRCUMFERENCE}
      />
    </svg>
  );
}
