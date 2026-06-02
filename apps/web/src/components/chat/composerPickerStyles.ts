// FILE: composerPickerStyles.ts
// Purpose: Shared tokens for picker open panels (shell, options, radius) and composer chrome.
// Layer: UI styling helper
// Exports: surface/option/radius tokens; open panels via ComposerPickerMenuPopup / ComposerPickerSelectPopup

export { COMPOSER_PICKER_SIZE, type ComposerPickerSize } from "./composerPickerSize";

/** Soft, dispersed outer shadow for the composer input shell and floating pickers. */
export const COMPOSER_SURFACE_SHADOW_CLASS_NAME =
  "shadow-[0_4px_18px_-6px_color-mix(in_srgb,var(--foreground)_7%,transparent)] dark:shadow-[0_6px_24px_-10px_rgba(0,0,0,0.30)]";

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
export const COMPOSER_PICKER_RADIUS_CLASS_NAME = "rounded-[0.8rem]";

/** Collapsible section headers inside model provider lists. */
export const COMPOSER_PICKER_MODEL_GROUP_HEADER_CLASS_NAME = `grid w-full grid-cols-[0.75rem_minmax(0,1fr)_2.5rem] items-center gap-x-1.5 ${COMPOSER_PICKER_RADIUS_CLASS_NAME} px-2 py-1 text-left text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground/80 outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] focus-visible:ring-0`;

/** Indents model row labels under collapsible group headers. */
export const COMPOSER_PICKER_MODEL_ROW_LABEL_INDENT_CLASS_NAME = "pl-[1.125rem]";

/** Muted accent text for effort labels and empty-landing folder names. */
export const COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME = "text-muted-foreground/45";

// NOTE: Composer picker section headers (Effort, Thinking, Mode, …) now render
// through the shared `MenuGroupLabel` primitive (../ui/menu) so they stay in
// sync with dropdown group labels like "Git actions". Picker padding is still
// tuned via the `--picker-section-py` token on `[data-slot="menu-label"]`.

export const COMPOSER_MAX_WIDTH_CLASS_NAME = "max-w-[42rem]";
/** Main chat column background — matches the theme Background setting exactly. */
export const CHAT_BACKGROUND_CLASS_NAME = "bg-[var(--color-background-surface)]";

/** Shared max width for the chat column (transcript + composer). */
export const CHAT_COLUMN_MAX_WIDTH_CLASS_NAME = COMPOSER_MAX_WIDTH_CLASS_NAME;
/** Horizontal padding shared by the transcript and composer columns. */
export const CHAT_COLUMN_GUTTER_CLASS_NAME = "px-3 sm:px-5";
/** Centers the chat column and applies the shared max width. */
export const CHAT_COLUMN_FRAME_CLASS_NAME = "mx-auto w-full min-w-0 max-w-[42rem]";

/** Max width for the composer shell only; outer wrappers stay full width for shadow bleed. */
export const COMPOSER_COLUMN_FRAME_CLASS_NAME = CHAT_COLUMN_FRAME_CLASS_NAME;

/** Opaque base behind the composer shell: the composer overlaps the scrolling
 *  transcript (`-mt-5`), so without a solid backing the frosted surface would let
 *  transcript text bleed through its top edge. Match the chat surface to stay seamless. */
export const COMPOSER_INPUT_SHELL_CLASS_NAME =
  "group rounded-[1.2rem] bg-[var(--color-background-surface)] transition-colors duration-200";

/** Defined composer border: the heaviest border token nudged a bit darker with foreground. */
export const COMPOSER_SURFACE_BORDER_CLASS_NAME =
  "border-[color:color-mix(in_srgb,var(--color-border-heavy)_95%,var(--foreground)_5%)]";

/** Border + shadow chrome for the composer shell: 1px defined border in light mode only;
 *  dark mode drops the border and leans on the shadow for separation. */
export const COMPOSER_SURFACE_CHROME_CLASS_NAME = `border ${COMPOSER_SURFACE_BORDER_CLASS_NAME} ${COMPOSER_SURFACE_SHADOW_CLASS_NAME} dark:border-transparent`;

export const COMPOSER_INPUT_SURFACE_CLASS_NAME = `chat-composer-surface rounded-[1.2rem] ${COMPOSER_SURFACE_CHROME_CLASS_NAME} transition-colors duration-200`;

/** Active segment fill in the sidebar Threads/Workspace picker. */
export const SIDEBAR_SEGMENTED_PICKER_ACTIVE_CLASS_NAME =
  "relative z-[1] text-[var(--color-text-foreground)]";

/** Shadcn default-translucent shell for floating menus, pickers, and popovers. */
export const APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME =
  "relative overflow-hidden border border-border bg-popover/70 text-popover-foreground before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150";

/** Default floating popup shell (dropdown menus, selects, popovers). */
export const APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME = `${APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME} rounded-2xl shadow-xl`;

/** Frosted backdrop layer inside composer picker dropdown panels. @deprecated Use APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME instead. */
export const COMPOSER_PICKER_MENU_BACKDROP_CLASS_NAME = "composer-picker-menu-surface";

/** Shared border, radius, and shadow for composer-attached popup panels. */
export const COMPOSER_PICKER_MENU_SURFACE_CHROME_CLASS_NAME = `border border-border ${COMPOSER_PICKER_RADIUS_CLASS_NAME} ${COMPOSER_SURFACE_SHADOW_CLASS_NAME}`;

/** Visual shell for composer picker dropdown panels (menus attached to the composer). */
export const COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME = `${APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME} ${COMPOSER_PICKER_MENU_SURFACE_CHROME_CLASS_NAME}`;

/** Frosted backdrop layer inside open picker panels (composer menus + settings selects). */
export const COMPOSER_PICKER_MENU_POPUP_BACKDROP_LAYER_CLASS_NAME = `${COMPOSER_PICKER_MENU_BACKDROP_CLASS_NAME} pointer-events-none absolute inset-0 rounded-[inherit]`;

/** Scrollable list body inside open picker panels. */
export const COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME = `relative z-1 w-full min-w-0 overflow-y-auto overscroll-contain ${COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME}`;

/** Viewport wrapper for anchored select popups (width follows trigger). */
export const COMPOSER_PICKER_MENU_POPUP_VIEWPORT_CLASS_NAME =
  "relative min-w-(--anchor-width) max-h-[min(var(--available-height),28rem)]";

/** Option row shared by composer menus and composer-surface select popups. Sizing via picker size CSS vars. */
export const COMPOSER_PICKER_MENU_OPTION_CLASS_NAME = `[&>svg]:-mx-0.5 flex cursor-default select-none items-center ${COMPOSER_PICKER_RADIUS_CLASS_NAME} text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)] outline-none data-disabled:pointer-events-none data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-[var(--color-text-foreground)] data-disabled:opacity-64 [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg]:pointer-events-none [&>svg]:shrink-0`;

/** Same as menu options, adapted for select item grid layout. */
export const COMPOSER_PICKER_SELECT_OPTION_CLASS_NAME = `${COMPOSER_PICKER_MENU_OPTION_CLASS_NAME} grid in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)]`;

/** Same chrome as picker menus, for composer-attached tooltips. */
export const COMPOSER_PICKER_TOOLTIP_SURFACE_CLASS_NAME = `${COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME} font-normal text-[var(--color-text-foreground)]`;

/** Opaque floating panel for the slash/mention command menu and @local browser.
 *  Picker border/radius/shadow, but a solid fill: the menu floats over the
 *  transcript, so frosted bg-popover/70 would let chat content bleed through. */
export const COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME = `relative overflow-hidden bg-popover text-popover-foreground ${COMPOSER_PICKER_MENU_SURFACE_CHROME_CLASS_NAME}`;

/** Anchors the command menu above the composer editor without shifting layout. */
export const COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME =
  "pointer-events-auto absolute inset-x-0 bottom-full z-20 mb-2 overflow-visible px-1 pt-1.5";

/** Default command menu row — transparent until hover or keyboard highlight. */
export const COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME =
  "flex cursor-pointer select-none items-center gap-2 rounded-full px-2.5 py-1 transition-colors hover:bg-[var(--color-background-elevated-secondary-opaque)] data-highlighted:bg-[var(--color-background-elevated-secondary-opaque)]";

/** Active command menu row — keyboard-selected pill fill. */
export const COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME =
  "bg-[var(--color-background-elevated-secondary-opaque)] text-[var(--color-text-foreground)]";

export const COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME = `rounded-t-[calc(1.2rem_-_1px)] border-b ${COMPOSER_SURFACE_BORDER_CLASS_NAME} bg-[var(--color-background-elevated-secondary)]`;

export const RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME =
  "text-[var(--runtime-full-access-accent)] hover:opacity-85";

/** Minimum composer editor height — two lines at the element's line-height. */
export const COMPOSER_EDITOR_LINE_HEIGHT_CLASS_NAME = "leading-tight";
export const COMPOSER_EDITOR_TEXT_CLASS_NAME = "text-[length:var(--app-font-size-chat,12px)]";
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
