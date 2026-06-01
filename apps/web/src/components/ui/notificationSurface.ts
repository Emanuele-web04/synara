// FILE: notificationSurface.ts
// Purpose: Shared visual tokens for transient and inline notification surfaces.
// Layer: UI styling helper
// Exports: notification surface class names used by toast and status banners.

export const COMPACT_NOTIFICATION_SURFACE_CLASS_NAME =
  "w-max max-w-[min(calc(100vw-2rem),28rem)] rounded-lg border border-[color-mix(in_srgb,var(--color-text-accent)_32%,transparent)] bg-[color-mix(in_srgb,var(--color-text-accent)_50%,transparent)] text-white shadow-lg/15 backdrop-blur-xl before:hidden dark:border-[color-mix(in_srgb,var(--color-text-accent)_10%,transparent)] dark:bg-[color-mix(in_srgb,var(--color-text-accent)_10%,transparent)]";

export const EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME =
  "w-full rounded-xl border border-[color-mix(in_srgb,var(--color-text-accent)_32%,transparent)] bg-[color-mix(in_srgb,var(--color-text-accent)_50%,transparent)] text-white shadow-lg/15 backdrop-blur-xl before:hidden dark:border-[color-mix(in_srgb,var(--color-text-accent)_10%,transparent)] dark:bg-[color-mix(in_srgb,var(--color-text-accent)_10%,transparent)]";

export const NOTIFICATION_ICON_CLASS_NAME = "text-white/92";
