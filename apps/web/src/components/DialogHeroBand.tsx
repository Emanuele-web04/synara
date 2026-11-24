// FILE: DialogHeroBand.tsx
// Purpose: The decorative band that opens a dialog: a faint dot grid with a soft sky glow
//          under a small scene. Shared by Add a device, the announcement sheets, and the
//          app tour cards so every one of them opens the same way.
// Layer: Web UI primitive
// Exports: DialogHeroBand, DIALOG_HERO_ITEM_SHADOW_CLASS_NAME, DIALOG_HERO_TILE_CLASS_NAME

import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";

const HERO_BACKGROUND: CSSProperties = {
  backgroundImage:
    "radial-gradient(circle at 50% 120%, color-mix(in srgb, var(--color-sky-400) 14%, transparent), transparent 62%), radial-gradient(color-mix(in srgb, var(--foreground) 8%, transparent) 1px, transparent 1.3px)",
  backgroundSize: "100% 100%, 14px 14px",
};

/** Lift for the objects standing in the band (devices, windows, tiles). */
export const DIALOG_HERO_ITEM_SHADOW_CLASS_NAME =
  "shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)]";

/** A 64px app tile standing in the band. */
export const DIALOG_HERO_TILE_CLASS_NAME = cn(
  "flex size-16 shrink-0 items-center justify-center rounded-[18px] border border-border bg-popover text-foreground",
  DIALOG_HERO_ITEM_SHADOW_CLASS_NAME,
);

const HERO_LINK_WIDTH = 76;
const HERO_PACKET_SIZE = 6;

/**
 * A dashed link between two band objects with a packet travelling across it, and an
 * optional badge (a key, a check) riding in the middle. The packet rests hidden under
 * reduced motion; the link and badge stay.
 */
export function DialogHeroLink(props: { badge?: ReactNode; delayMs?: number }) {
  return (
    <span
      className="relative flex h-8 shrink-0 items-center justify-center"
      style={{ width: HERO_LINK_WIDTH }}
    >
      <span className="absolute inset-x-0 top-1/2 border-t border-dashed border-foreground/20" />
      <span
        className="scene-packet absolute top-1/2 left-0 rounded-full bg-sky-500 dark:bg-sky-400"
        style={
          {
            width: HERO_PACKET_SIZE,
            height: HERO_PACKET_SIZE,
            marginTop: -HERO_PACKET_SIZE / 2,
            animationDelay: props.delayMs ? `${props.delayMs}ms` : undefined,
            "--scene-travel-x": `${HERO_LINK_WIDTH - HERO_PACKET_SIZE}px`,
          } as CSSProperties
        }
      />
      {props.badge ? (
        <span className="relative flex size-7 items-center justify-center rounded-full bg-sky-500 text-white ring-4 ring-sky-500/15 dark:bg-sky-400 dark:text-popover dark:ring-sky-400/15">
          {props.badge}
        </span>
      ) : null}
    </span>
  );
}

export function DialogHeroBand(props: { children: ReactNode; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex h-40 shrink-0 items-center justify-center overflow-hidden bg-muted/60 select-none",
        props.className,
      )}
      style={HERO_BACKGROUND}
    >
      {props.children}
    </div>
  );
}
