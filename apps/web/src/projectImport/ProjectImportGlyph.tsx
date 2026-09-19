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
  { tile: string; fill: string; icon: string; overlap: string; dot: string; gap: string }
> = {
  md: {
    tile: "size-10 rounded-[12px]",
    fill: "rounded-[11px]",
    icon: "size-5",
    overlap: "-ml-2.5",
    dot: "size-[3px]",
    gap: "gap-2",
  },
  lg: {
    tile: "size-14 rounded-[16px]",
    fill: "rounded-[15px]",
    icon: "size-7",
    overlap: "-ml-3.5",
    dot: "size-1",
    gap: "gap-3",
  },
};

const CLAUDE_GLOW = "color-mix(in srgb, #d97757 60%, transparent)";
const NEUTRAL_GLOW = "color-mix(in srgb, var(--foreground) 38%, transparent)";

// Tile chrome: a 1px border that is brightest on the edge facing the connector dots and
// fades out across the tile, drawn as a gradient ring around an opaque fill.
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
      className={cn("flex shrink-0 p-px shadow-sm", classes.tile, props.className)}
      style={{
        backgroundImage: `linear-gradient(to ${props.glow === "right" ? "left" : "right"}, ${props.glowColor}, color-mix(in srgb, var(--foreground) 7%, transparent) 75%)`,
      }}
    >
      <span
        className={cn(
          "flex size-full items-center justify-center bg-[color-mix(in_srgb,var(--background)_94%,var(--foreground))]",
          classes.fill,
        )}
      >
        {props.children}
      </span>
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
