// FILE: composerPickerStyles.ts
// Purpose: Shares typography tokens for the chat composer pickers.
// Layer: UI styling helper for chat controls.
// Exports: COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME, composer input shell/surface class names

/** Soft, dispersed outer shadow for the composer input shell. */
export const COMPOSER_INPUT_SHADOW_CLASS_NAME =
  "shadow-[0_4px_18px_-6px_color-mix(in_srgb,var(--foreground)_10%,transparent)] dark:shadow-[0_6px_24px_-10px_rgba(0,0,0,0.42)]";

// Uses the UI-sm token so picker labels sit slightly below the editor text size.
// The sm: override is required to beat the Button component's base responsive text classes.
export const COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME =
  "text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--color-text-foreground-secondary)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal hover:text-[var(--color-text-foreground)] data-pressed:text-[var(--color-text-foreground)]";

/** Muted accent text for effort labels and empty-landing folder names. */
export const COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME = "text-muted-foreground/45";

export const COMPOSER_MAX_WIDTH_CLASS_NAME = "max-w-[40rem]";
/** Shared max width for the chat column (transcript + composer). */
export const CHAT_COLUMN_MAX_WIDTH_CLASS_NAME = COMPOSER_MAX_WIDTH_CLASS_NAME;
/** Horizontal padding shared by the transcript and composer columns. */
export const CHAT_COLUMN_GUTTER_CLASS_NAME = "px-3 sm:px-5";
/** Centers the chat column and applies the shared max width. */
export const CHAT_COLUMN_FRAME_CLASS_NAME =
  "mx-auto w-full min-w-0 max-w-[40rem]";

/** Max width for the composer shell only; outer wrappers stay full width for shadow bleed. */
export const COMPOSER_COLUMN_FRAME_CLASS_NAME = CHAT_COLUMN_FRAME_CLASS_NAME;

export const COMPOSER_INPUT_SHELL_CLASS_NAME =
  "group rounded-2xl p-px transition-colors duration-200";

/** Light mode: stronger border for the composer shell; dark banner keeps the softer mix. */
export const COMPOSER_INPUT_BORDER_COLOR_CLASS_NAME =
  "border-[color:var(--color-border-heavy)] dark:border-[color:color-mix(in_srgb,var(--color-border-light)_45%,var(--color-border)_55%)]";

export const COMPOSER_INPUT_SURFACE_CLASS_NAME =
  `chat-composer-surface rounded-2xl border ${COMPOSER_INPUT_BORDER_COLOR_CLASS_NAME} ${COMPOSER_INPUT_SHADOW_CLASS_NAME} transition-colors duration-200 dark:border-transparent`;

export const COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME =
  `rounded-t-[calc(var(--radius-2xl)-1px)] border-b ${COMPOSER_INPUT_BORDER_COLOR_CLASS_NAME} bg-[var(--color-background-elevated-secondary)]`;

export const RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME =
  "text-[var(--runtime-full-access-accent)] hover:opacity-85";

/** Minimum composer editor height — two lines at the element's line-height. */
export const COMPOSER_EDITOR_LINE_HEIGHT_CLASS_NAME = "leading-tight";
export const COMPOSER_EDITOR_TEXT_CLASS_NAME =
  "text-[length:var(--app-font-size-chat,12px)]";
export const COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME = "min-h-[2lh]";
/** Lexical wraps lines in `<p>` nodes; reset default margins so text sits flush above the footer. */
export const COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME = "[&_p]:m-0";
/** Horizontal inset shared by the composer editor and bottom bar. */
export const COMPOSER_HORIZONTAL_INSET_CLASS_NAME = "px-3";
/** Shared padding around the composer prompt editor. */
export const COMPOSER_EDITOR_PADDING_CLASS_NAME = `relative ${COMPOSER_HORIZONTAL_INSET_CLASS_NAME} pt-3 pb-2`;
/** Bottom bar row — flush to the composer shell edges. */
export const COMPOSER_FOOTER_ROW_CLASS_NAME = "flex items-end justify-between px-2 pb-1.5";
export const COMPOSER_FOOTER_APPROVAL_ROW_CLASS_NAME =
  "flex items-center justify-end gap-2 px-2 pb-1.5";
