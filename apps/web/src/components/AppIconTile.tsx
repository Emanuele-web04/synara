// FILE: AppIconTile.tsx
// Purpose: App-icon tiles joined by connector dots, shared by the project import
//   promos and the connector consent dialog.
// Layer: Web UI primitive
// Exports: AppIconTile, ConnectorDots, APP_ICON_TILE_SIZE_CLASSES

import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";

export type AppIconTileSize = "md" | "lg" | "xl";

export const APP_ICON_TILE_SIZE_CLASSES: Record<
  AppIconTileSize,
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
  xl: {
    tile: "size-16",
    radius: "rounded-[18px]",
    icon: "size-8",
    overlap: "-ml-4",
    dot: "size-1.5",
    gap: "gap-3",
  },
};

// Tile chrome: a 1px border that is brightest on the edge facing the connector dots and
// fades out across the tile. The gradient is masked down to the ring so the tile stays
// transparent and only the outline reads.
export function AppIconTile(props: {
  children: ReactNode;
  size: AppIconTileSize;
  // Edge that carries the highlight; the ring fades toward the opposite edge.
  glow: "left" | "right";
  glowColor: string;
  className?: string;
  style?: CSSProperties;
}) {
  const classes = APP_ICON_TILE_SIZE_CLASSES[props.size];
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center",
        classes.tile,
        classes.radius,
        props.className,
      )}
      style={props.style}
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

/** Three dots between two tiles; `dotClassNames` styles each dot, nearest first. */
export function ConnectorDots(props: {
  size: AppIconTileSize;
  dotClassNames: readonly [string, string, string];
}) {
  const dot = APP_ICON_TILE_SIZE_CLASSES[props.size].dot;
  const [first, second, third] = props.dotClassNames;
  return (
    <span className="flex items-center gap-[3px]">
      <span className={cn("rounded-full", dot, first)} />
      <span className={cn("rounded-full", dot, second)} />
      <span className={cn("rounded-full", dot, third)} />
    </span>
  );
}
