// FILE: composerPickerStyles.ts
// Purpose: Shared tokens for picker open panels (shell, options, radius) and composer chrome.
// Layer: UI styling helper
// Exports: surface/option/radius tokens; open panels via ComposerPickerMenuPopup / ComposerPickerSelectPopup

export { COMPOSER_PICKER_SIZE, type ComposerPickerSize } from "./composerPickerSize";

/** Soft, dispersed outer shadow for the composer input shell and floating pickers. */
export const COMPOSER_SURFACE_SHADOW_CLASS_NAME =
  "shadow-[0_4px_18px_-6px_color-mix(in_srgb,var(--foreground)_10%,transparent)] dark:shadow-[0_6px_24px_-10px_rgba(0,0,0,0.42)]";

// Uses the UI-sm token so picker labels sit slightly below the editor text size.
// The sm: override is required to beat the Button component's base responsive text classes.
export const COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME =
  "text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--color-text-foreground-secondary)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal hover:text-[var(--color-text-foreground)] data-pressed:text-[var(--color-text-foreground)]";

/** Caps model-provider submenu height; pairs with the list scroll class below. */
export const COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME =
  "[--available-height:min(20rem,55vh)]";

/** Sticky search header inside frosted composer picker submenus. */
export const COMPOSER_PICKER_SEARCH_HEADER_CLASS_NAME =
  "sticky z-20 shrink-0 border-b border-[color:color-mix(in_srgb,var(--foreground)_6%,transparent)] bg-transparent px-1.5 pb-1.5 pt-1";

/** Search field styling inside composer picker submenus. */
export const COMPOSER_PICKER_SEARCH_INPUT_CLASS_NAME =
  "rounded-lg border-[color:color-mix(in_srgb,var(--foreground)_8%,transparent)] bg-[color-mix(in_srgb,white_92%,transparent)] shadow-none before:hidden has-focus-visible:border-[color:color-mix(in_srgb,var(--foreground)_14%,transparent)] has-focus-visible:ring-0 [&_input]:font-sans [&_input]:placeholder:text-muted-foreground/55";

/** Scrollable model list body inside searchable provider submenus. */
export const COMPOSER_PICKER_MODEL_LIST_MAX_HEIGHT_CLASS_NAME =
  "max-h-[min(var(--available-height,20rem),20rem)]";

/** Scroll chrome for long model-provider lists. */
export const COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME = "composer-picker-scroll";

/** Shared corner radius for picker panels and option hover/selection rows. */
export const COMPOSER_PICKER_RADIUS_CLASS_NAME = "rounded-lg";

/** Collapsible section headers inside model provider lists. */
export const COMPOSER_PICKER_MODEL_GROUP_HEADER_CLASS_NAME =
  `flex w-full items-center gap-1.5 ${COMPOSER_PICKER_RADIUS_CLASS_NAME} px-2 py-1.5 text-left text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground/80 outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] focus-visible:ring-0`;

/** Muted accent text for effort labels and empty-landing folder names. */
export const COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME = "text-muted-foreground/45";

/** Section headers inside composer picker menus (Effort, Thinking, Speed, etc.). */
export const COMPOSER_PICKER_SECTION_LABEL_CLASS_NAME =
  `px-2 py-[var(--picker-section-py,0.375rem)] font-normal text-xs ${COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME}`;

export const COMPOSER_MAX_WIDTH_CLASS_NAME = "max-w-[42rem]";
/** Main chat column background — matches the theme Background setting exactly. */
export const CHAT_BACKGROUND_CLASS_NAME = "bg-[var(--color-background-surface)]";

/** Shared max width for the chat column (transcript + composer). */
export const CHAT_COLUMN_MAX_WIDTH_CLASS_NAME = COMPOSER_MAX_WIDTH_CLASS_NAME;
/** Horizontal padding shared by the transcript and composer columns. */
export const CHAT_COLUMN_GUTTER_CLASS_NAME = "px-3 sm:px-5";
/** Centers the chat column and applies the shared max width. */
export const CHAT_COLUMN_FRAME_CLASS_NAME =
  "mx-auto w-full min-w-0 max-w-[42rem]";

/** Max width for the composer shell only; outer wrappers stay full width for shadow bleed. */
export const COMPOSER_COLUMN_FRAME_CLASS_NAME = CHAT_COLUMN_FRAME_CLASS_NAME;

export const COMPOSER_INPUT_SHELL_CLASS_NAME =
  "group rounded-[1.2rem] p-px transition-colors duration-200";

/** Light mode: stronger border for the composer shell; dark banner keeps the softer mix. */
export const COMPOSER_SURFACE_BORDER_CLASS_NAME =
  "border-[color:var(--color-border-heavy)] dark:border-[color:color-mix(in_srgb,var(--color-border-light)_45%,var(--color-border)_55%)]";

/** Shared border + shadow chrome for the composer shell and its floating pickers. */
export const COMPOSER_SURFACE_CHROME_CLASS_NAME =
  `border ${COMPOSER_SURFACE_BORDER_CLASS_NAME} ${COMPOSER_SURFACE_SHADOW_CLASS_NAME} dark:border-transparent`;

export const COMPOSER_INPUT_SURFACE_CLASS_NAME =
  `chat-composer-surface rounded-[1.2rem] ${COMPOSER_SURFACE_CHROME_CLASS_NAME} transition-colors duration-200`;

/** Frosted backdrop layer inside composer picker dropdown panels. */
export const COMPOSER_PICKER_MENU_BACKDROP_CLASS_NAME = "composer-picker-menu-surface";

/** Visual shell for composer picker dropdown panels (menus attached to the composer). */
export const COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME =
  `overflow-hidden ${COMPOSER_PICKER_RADIUS_CLASS_NAME} bg-transparent ${COMPOSER_SURFACE_CHROME_CLASS_NAME}`;

/** Frosted backdrop layer inside open picker panels (composer menus + settings selects). */
export const COMPOSER_PICKER_MENU_POPUP_BACKDROP_LAYER_CLASS_NAME =
  `${COMPOSER_PICKER_MENU_BACKDROP_CLASS_NAME} pointer-events-none absolute inset-0 rounded-[inherit]`;

/** Scrollable list body inside open picker panels. */
export const COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME =
  `relative z-1 w-full min-w-0 overflow-y-auto overscroll-contain ${COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME}`;

/** Viewport wrapper for anchored select popups (width follows trigger). */
export const COMPOSER_PICKER_MENU_POPUP_VIEWPORT_CLASS_NAME =
  "relative min-w-(--anchor-width) max-h-[min(var(--available-height),28rem)]";

/** Option row shared by composer menus and composer-surface select popups. Sizing via picker size CSS vars. */
export const COMPOSER_PICKER_MENU_OPTION_CLASS_NAME =
  `[&>svg]:-mx-0.5 flex cursor-default select-none items-center rounded-lg text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)] outline-none data-disabled:pointer-events-none data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-[var(--color-text-foreground)] data-disabled:opacity-64 [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg]:pointer-events-none [&>svg]:shrink-0`;

/** Same as menu options, adapted for select item grid layout. */
export const COMPOSER_PICKER_SELECT_OPTION_CLASS_NAME =
  `${COMPOSER_PICKER_MENU_OPTION_CLASS_NAME} grid in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)]`;

/** Same chrome as picker menus, for composer-attached tooltips. */
export const COMPOSER_PICKER_TOOLTIP_SURFACE_CLASS_NAME =
  `${COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME} font-normal text-[var(--color-text-foreground)]`;

export const COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME =
  `rounded-t-[calc(1.2rem_-_1px)] border-b ${COMPOSER_SURFACE_BORDER_CLASS_NAME} bg-[var(--color-background-elevated-secondary)]`;

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
