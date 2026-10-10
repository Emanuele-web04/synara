// FILE: SubagentAvatar.tsx
// Purpose: Small deterministic glyph avatars for subagents (Codex-style): a geometric mark
//          tinted with the subagent's accent color, picked from its stable key so siblings
//          that share a color still read apart. Plus a compact stack for summary rows.
// Layer: Chat UI primitive
// Exports: SubagentAvatar, SubagentAvatarStack

import type { ReactNode } from "react";

import { hashLabelSeed } from "~/lib/subagentPresentation";
import { cn } from "~/lib/utils";

// Each glyph draws in currentColor on a 16×16 grid; opacity layers add depth.
const SUBAGENT_GLYPHS: ReadonlyArray<ReactNode> = [
  // Petals
  <>
    <circle cx="5" cy="5" r="3" opacity="0.5" />
    <circle cx="11" cy="5" r="3" opacity="0.5" />
    <circle cx="5" cy="11" r="3" opacity="0.5" />
    <circle cx="11" cy="11" r="3" opacity="0.5" />
    <circle cx="8" cy="8" r="2.5" />
  </>,
  // Diamonds
  <>
    <path d="M8 1.5 10.5 4 8 6.5 5.5 4Z" opacity="0.55" />
    <path d="M8 9.5 10.5 12 8 14.5 5.5 12Z" opacity="0.55" />
    <path d="M4 5.5 6.5 8 4 10.5 1.5 8Z" opacity="0.55" />
    <path d="M12 5.5 14.5 8 12 10.5 9.5 8Z" opacity="0.55" />
    <path d="M8 5.5 10.5 8 8 10.5 5.5 8Z" />
  </>,
  // Orbit
  <>
    <circle
      cx="8"
      cy="8"
      r="6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      opacity="0.55"
    />
    <circle cx="8" cy="8" r="2.75" />
  </>,
  // Dot grid
  <>
    {[3.5, 8, 12.5].flatMap((cy) =>
      [3.5, 8, 12.5].map((cx) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r={cx === 8 && cy === 8 ? 2.25 : 1.5}
          opacity={cx === 8 && cy === 8 ? 1 : 0.55}
        />
      )),
    )}
  </>,
  // Quartered disc
  <>
    <circle cx="8" cy="8" r="6.5" opacity="0.45" />
    <path d="M8 1.5v13M1.5 8h13" stroke="currentColor" strokeWidth="1.4" opacity="0.9" />
  </>,
  // Burst
  <>
    {[0, 45, 90, 135].map((angle) => (
      <rect
        key={angle}
        x="7"
        y="1.5"
        width="2"
        height="13"
        rx="1"
        opacity="0.5"
        transform={`rotate(${angle} 8 8)`}
      />
    ))}
    <circle cx="8" cy="8" r="2.5" />
  </>,
];

export function SubagentAvatar({
  seed,
  accentColor,
  className,
}: {
  /** Stable per-subagent key (the provider thread id). */
  seed: string;
  accentColor: string;
  className?: string;
}) {
  const glyph = SUBAGENT_GLYPHS[hashLabelSeed(seed) % SUBAGENT_GLYPHS.length];
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className={cn("size-4 shrink-0", className)}
      style={{ color: accentColor }}
    >
      {glyph}
    </svg>
  );
}

export function SubagentAvatarStack({
  items,
  className,
}: {
  items: ReadonlyArray<{ key: string; accentColor: string }>;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5", className)} aria-hidden>
      {items.map((item) => (
        <SubagentAvatar key={item.key} seed={item.key} accentColor={item.accentColor} />
      ))}
    </span>
  );
}
