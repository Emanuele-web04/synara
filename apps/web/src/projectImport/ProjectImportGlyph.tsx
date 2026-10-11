// FILE: ProjectImportGlyph.tsx
// Purpose: Claude Code + Codex → Synara tile illustration shared by the project import promos.
// Layer: Web project-import UI
// Exports: ProjectImportGlyph

import type { ReactNode } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { SynaraLogo } from "~/components/SynaraLogo";
import { cn } from "~/lib/utils";

type GlyphSize = "md" | "lg";

const SIZE_CLASSES: Record<
  GlyphSize,
  { tile: string; radius: string; icon: string; overlap: string; dot: string; gap: string }
> = {
  md: {
    tile: "size-10",
    radius: "rounded-[12px]",
    icon: "size-5",
    overlap: "-ml-2.5",
    dot: "size-[3px]",
    gap: "gap-2",
  },
  lg: {
    tile: "size-14",
    radius: "rounded-[16px]",
    icon: "size-7",
    overlap: "-ml-3.5",
    dot: "size-1",
    gap: "gap-3",
  },
};

const CLAUDE_GLOW = "color-mix(in srgb, #d97757 60%, transparent)";
const NEUTRAL_GLOW = "color-mix(in srgb, var(--foreground) 38%, transparent)";

// Tile chrome: a 1px border that is brightest on the edge facing the connector dots and
// fades out across the tile. The gradient is masked down to the ring so the tile stays
// transparent and only the outline reads.
function IconTile(props: {
  children: ReactNode;
  size: GlyphSize;
  // Edge that carries the highlight; the ring fades toward the opposite edge.
  glow: "left" | "right";
  glowColor: string;
  className?: string;
}) {
  const classes = SIZE_CLASSES[props.size];
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center",
        classes.tile,
        classes.radius,
        props.className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("pointer-events-none absolute inset-0 p-px", classes.radius)}
        style={{
          backgroundImage: `linear-gradient(to ${props.glow === "right" ? "left" : "right"}, ${props.glowColor}, color-mix(in srgb, var(--foreground) 7%, transparent) 75%)`,
          mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
          maskComposite: "exclude",
          WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
          WebkitMaskComposite: "xor",
        }}
      />
      {props.children}
    </span>
  );
}

export function ProjectImportGlyph(props: { size?: GlyphSize; className?: string }) {
  const size = props.size ?? "md";
  const classes = SIZE_CLASSES[size];
  return (
    <span
      className={cn("flex shrink-0 items-center", classes.gap, props.className)}
      aria-hidden="true"
    >
      <span className="flex items-center">
        <IconTile
          size={size}
          glow="right"
          glowColor={CLAUDE_GLOW}
          className="relative z-10 -rotate-6"
        >
          <ProviderIcon provider="claudeAgent" className={classes.icon} />
        </IconTile>
        <IconTile
          size={size}
          glow="right"
          glowColor={NEUTRAL_GLOW}
          className={cn("rotate-3", classes.overlap)}
        >
          <ProviderIcon provider="codex" className={classes.icon} />
        </IconTile>
      </span>
      <span className="flex items-center gap-[3px]">
        <span className={cn("rounded-full bg-[#d97757]/45", classes.dot)} />
        <span className={cn("rounded-full bg-[#d97757]/70", classes.dot)} />
        <span className={cn("rounded-full bg-[#d97757]", classes.dot)} />
      </span>
      <IconTile size={size} glow="left" glowColor={NEUTRAL_GLOW} className="rotate-6">
        <SynaraLogo className={classes.icon} />
      </IconTile>
    </span>
  );
}
