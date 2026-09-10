// FILE: notificationSurface.ts
// Purpose: Shared visual tokens for transient and inline notification surfaces.
// Layer: UI styling helper
// Exports: notification surface class names/tones used by toast and status banners.

import { cn } from "~/lib/utils";

// Every notification card shares the same neutral popover chrome; only the
// error tone tints the surface. Children reference `--notification-fg` via
// `text-[var(--notification-fg)]` so text/icon/control color lives in one place
// for both toasts and inline notification banners.
//
// `[-webkit-app-region:no-drag]` keeps the card (and every control inside it,
// notably the dismiss "X") clickable in the desktop app. Toasts render at the
// top edge over Electron's draggable titlebar region; without this the OS
// captures clicks in that band for window dragging and the X stops working.
const NOTIFICATION_SURFACE_BASE_CLASS_NAME =
  "border border-border bg-popover/94 [--notification-fg:var(--popover-foreground)] text-[var(--notification-fg)] shadow-lg/10 backdrop-blur-xl before:hidden [-webkit-app-region:no-drag] dark:shadow-lg/15";

export const COMPACT_NOTIFICATION_SURFACE_CLASS_NAME = `w-max max-w-[min(calc(100vw-2rem),28rem)] rounded-xl ${NOTIFICATION_SURFACE_BASE_CLASS_NAME}`;

export const EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME = `w-full rounded-2xl ${NOTIFICATION_SURFACE_BASE_CLASS_NAME}`;

// The icon carries the tone color while the copy stays on the neutral
// `--notification-fg`, so tones only need to set `--notification-icon-fg`.
export const NOTIFICATION_ICON_CLASS_NAME =
  "text-[var(--notification-icon-fg,var(--notification-fg))]/92";

export type NotificationTone = "default" | "error";

// Error notifications keep the same card geometry and swap the neutral popover for
// a light destructive wash. The copy deliberately keeps the theme foreground
// (near-white in dark themes, near-black in light ones) instead of the destructive
// role color, which reads muddy against the tint; the icon carries the red instead.
const ERROR_NOTIFICATION_TONE_CLASS_NAME =
  "border-[color-mix(in_srgb,var(--destructive)_16%,transparent)] bg-[color-mix(in_srgb,var(--destructive)_5%,var(--popover))] [--notification-icon-fg:var(--destructive)] dark:border-[color-mix(in_srgb,var(--destructive)_13%,transparent)] dark:bg-[color-mix(in_srgb,var(--destructive)_8%,var(--popover))]";

export function notificationSurfaceClassName(options: {
  compact: boolean;
  tone?: NotificationTone;
}): string {
  return cn(
    options.compact
      ? COMPACT_NOTIFICATION_SURFACE_CLASS_NAME
      : EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
    options.tone === "error" && ERROR_NOTIFICATION_TONE_CLASS_NAME,
  );
}
