// FILE: button-group.tsx
// Purpose: A joined capsule of related icon actions: one soft pill surface, round segments, and
//          optional hairline dividers between clusters.
// Layer: Shared UI primitive
// Exports: ButtonGroup, ButtonGroupSeparator, BUTTON_GROUP_ACTIVE_CLASS_NAME,
//          BUTTON_GROUP_SURFACE_CLASS_NAME, TOOLBAR_ICON_BUTTON_TONE_CLASS_NAME
// Notes: Composition only. Segments stay the app's own Button / IconButton / Menu triggers, so
//        tooltips, menus and pressed state keep working; the group just joins and rounds them.
//        Same joined-surface look as uiarc's button group, without its data-driven items API
//        (which has no toggle state) or its motion / Radix / lucide dependencies.

import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** Pressed look for a toggle segment: an accent tint on the group's pill (the file tree toggle). */
export const BUTTON_GROUP_ACTIVE_CLASS_NAME =
  "bg-[color-mix(in_srgb,var(--color-text-accent)_16%,transparent)] text-[var(--color-text-accent)] [:hover,[data-pressed]]:bg-[color-mix(in_srgb,var(--color-text-accent)_22%,transparent)] [:hover,[data-pressed]]:text-[var(--color-text-accent)]";

/** The capsule's own surface: a soft fill and hairline border on a full pill. Shared by the group
 *  and by any lone pill (a picker trigger) that has to read as the same element beside it. */
export const BUTTON_GROUP_SURFACE_CLASS_NAME =
  "rounded-full border border-[color:var(--color-border)] bg-[var(--color-background-button-secondary)]";

/** Resting tone of a group's icon segments: a muted glyph that comes up to full foreground on
 *  hover. */
export const TOOLBAR_ICON_BUTTON_TONE_CLASS_NAME = "text-muted-foreground hover:text-foreground";

export function ButtonGroup({
  className,
  label,
  ...props
}: Omit<ComponentProps<"div">, "aria-label"> & { label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="button-group"
      className={cn(
        "inline-flex shrink-0 items-center gap-px p-px [-webkit-app-region:no-drag] [&_button]:!size-7 [&_button]:rounded-full",
        BUTTON_GROUP_SURFACE_CLASS_NAME,
        className,
      )}
      {...props}
    />
  );
}

export function ButtonGroupSeparator({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      data-slot="button-group-separator"
      className={cn("mx-0.5 h-4 w-px shrink-0 bg-border", className)}
      {...props}
    />
  );
}
