// FILE: composerPickerStyles.ts
// Purpose: Shares typography tokens for the chat composer pickers.
// Layer: UI styling helper for chat controls.
// Exports: COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME

// Uses the UI-sm token so picker labels sit slightly below the editor text size.
// The sm: override is required to beat the Button component's base responsive text classes.
export const COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME =
  "text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-muted-foreground/70 hover:text-foreground/80";
