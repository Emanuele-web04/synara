// FILE: composerPickerStyles.ts
// Purpose: Shares typography tokens for the chat composer pickers.
// Layer: UI styling helper for chat controls.
// Exports: COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME

// Uses --composer-picker-font-size CSS variable set by ChatView from the chatFontSizePx setting.
// The sm: override is required to beat the Button component's base `sm:text-sm`.
export const COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME =
  "text-[length:var(--composer-picker-font-size,12px)] sm:text-[length:var(--composer-picker-font-size,12px)] font-normal text-muted-foreground/70 hover:text-foreground/80";
