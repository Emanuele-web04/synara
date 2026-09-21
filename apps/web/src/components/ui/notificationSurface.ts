import { cn } from "~/lib/utils";

// `[-webkit-app-region:no-drag]` keeps the card (and its dismiss X) clickable in the desktop app — toasts render over Electron's draggable titlebar band where the OS would otherwise capture clicks
const NOTIFICATION_SURFACE_BASE_CLASS_NAME =
  "border border-border bg-popover/94 [--notification-fg:var(--popover-foreground)] text-[var(--notification-fg)] shadow-lg/10 backdrop-blur-xl before:hidden [-webkit-app-region:no-drag] dark:shadow-lg/15";

export const COMPACT_NOTIFICATION_SURFACE_CLASS_NAME = `w-max max-w-[min(calc(100vw-2rem),28rem)] rounded-xl ${NOTIFICATION_SURFACE_BASE_CLASS_NAME}`;

export const EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME = `w-full rounded-2xl ${NOTIFICATION_SURFACE_BASE_CLASS_NAME}`;

// the icon carries the tone color while copy stays on `--notification-fg`, so tones only need to set `--notification-icon-fg`
export const NOTIFICATION_ICON_CLASS_NAME =
  "text-[var(--notification-icon-fg,var(--notification-fg))]/92";

export type NotificationTone = "default" | "error";

// error cards swap the neutral popover for a light destructive wash but keep theme foreground copy — the destructive role color reads muddy on the tint
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
