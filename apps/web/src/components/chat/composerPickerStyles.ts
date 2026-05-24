// FILE: composerPickerStyles.ts
// Purpose: Shares typography tokens for the chat composer pickers.
// Layer: UI styling helper for chat controls.
// Exports: COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME, composer input shell/surface class names

import { SURFACE_OUTER_SHADOW_CLASS_NAME } from "~/lib/surfaceElevation";

// Uses the UI-sm token so picker labels sit slightly below the editor text size.
// The sm: override is required to beat the Button component's base responsive text classes.
export const COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME =
  "text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--color-text-foreground-secondary)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal hover:text-[var(--color-text-foreground)] data-pressed:text-[var(--color-text-foreground)]";

export const COMPOSER_MAX_WIDTH_CLASS_NAME = "max-w-[40rem]";
/** Shared max width for the chat column (transcript + composer). */
export const CHAT_COLUMN_MAX_WIDTH_CLASS_NAME = COMPOSER_MAX_WIDTH_CLASS_NAME;
/** Horizontal padding shared by the transcript and composer columns. */
export const CHAT_COLUMN_GUTTER_CLASS_NAME = "px-3 sm:px-5";
/** Centers the chat column and applies the shared max width. */
export const CHAT_COLUMN_FRAME_CLASS_NAME =
  "mx-auto w-full min-w-0 max-w-[40rem]";

export const COMPOSER_INPUT_SHELL_CLASS_NAME =
  "group rounded-2xl p-px transition-colors duration-200";

/** Slightly stronger than `--color-border-light` for the composer input shell. */
export const COMPOSER_INPUT_BORDER_COLOR_CLASS_NAME =
  "border-[color:color-mix(in_srgb,var(--color-border-light)_55%,var(--color-border)_45%)]";

export const COMPOSER_INPUT_SURFACE_CLASS_NAME =
  `chat-composer-surface rounded-2xl border ${COMPOSER_INPUT_BORDER_COLOR_CLASS_NAME} ${SURFACE_OUTER_SHADOW_CLASS_NAME} transition-colors duration-200 dark:border-transparent`;

export const COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME =
  `rounded-t-[calc(var(--radius-2xl)-1px)] border-b ${COMPOSER_INPUT_BORDER_COLOR_CLASS_NAME} bg-[var(--color-background-elevated-secondary)]`;

export const RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME =
  "text-[var(--runtime-full-access-accent)] hover:opacity-85";

/** Minimum composer editor height — two lines at the element's line-height (`leading-relaxed`). */
export const COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME = "min-h-[2lh]";
