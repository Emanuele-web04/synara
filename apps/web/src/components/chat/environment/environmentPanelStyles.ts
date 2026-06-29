// FILE: environmentPanelStyles.ts
// Purpose: Shared Environment panel typography tokens. Section labels, the panel title,
//          and muted body copy (e.g. recap) all reuse the composer placeholder color so
//          secondary chrome reads consistently across the chat shell.
// Layer: Environment panel design tokens

import { COMPACT_CHAT_MARKDOWN_COZY_CLASS_NAME } from "~/components/chatMarkdownSpacing";
import {
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
  COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { cn } from "~/lib/utils";

/** Panel title ("Environment") and section labels ("Editor", "Recap"). */
export const ENVIRONMENT_PANEL_LABEL_CLASS_NAME = cn(
  "font-normal",
  COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
);

/** Top-of-card title row. */
export const ENVIRONMENT_PANEL_TITLE_CLASS_NAME = cn(
  ENVIRONMENT_PANEL_LABEL_CLASS_NAME,
  "text-[length:var(--app-font-size-ui,12px)]",
);

/**
 * Section-heading typography without row padding — used inline inside the collapsible
 * section header (which owns the padding alongside its chevron).
 */
export const ENVIRONMENT_PANEL_SECTION_LABEL_INLINE_CLASS_NAME = cn(
  ENVIRONMENT_PANEL_LABEL_CLASS_NAME,
  "text-[length:var(--app-font-size-ui-sm,11px)]",
);

/**
 * Section headings inside the card (standalone label row). Shares the collapsible-section
 * header's `px-2 py-1` box so static labels (e.g. "Repository", "Editor") line up on the same
 * vertical rhythm as the expand/collapse section headers.
 */
export const ENVIRONMENT_PANEL_SECTION_LABEL_CLASS_NAME = cn(
  ENVIRONMENT_PANEL_SECTION_LABEL_INLINE_CLASS_NAME,
  "px-2 py-1",
);

/** Muted secondary copy such as the recap body. */
export const ENVIRONMENT_PANEL_MUTED_BODY_CLASS_NAME = cn(
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
  COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
);

/** Recap markdown — same placeholder tone with markdown-specific spacing overrides. */
export const ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME = cn(
  ENVIRONMENT_PANEL_MUTED_BODY_CLASS_NAME,
  `!${COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME}`,
  "[&_strong]:font-medium [&_strong]:text-muted-foreground/40",
  "[&_:not(pre)>code]:!text-muted-foreground/45",
  COMPACT_CHAT_MARKDOWN_COZY_CLASS_NAME,
);
