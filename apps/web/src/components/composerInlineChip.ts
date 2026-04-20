// FILE: composerInlineChip.ts
// Purpose: Shares the inline chip styling and skill-label helpers used by the composer and chat.
// Layer: UI styling/utilities
// Exports: Chip class names plus shared skill icon/label helpers

export const COMPOSER_INLINE_CHIP_CLASS_NAME =
  "inline-flex max-w-full select-none items-center gap-0.5 rounded border border-border/40 bg-accent/25 px-1 py-px font-medium text-[11px] leading-[1.1] text-foreground/75 align-middle";

// Wrapper for file/folder mention chips. Mirrors the skill pill (same tint
// and rounding) but with tighter padding and smaller text so a path chip
// reads as a compact variant of a skill chip.
export const COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME =
  "inline-flex max-w-full select-none items-center gap-0.5 rounded-sm bg-[var(--info-foreground)]/10 pl-1.5 pr-2 py-0.5 text-[11px] font-medium text-[var(--info-foreground)]/80 align-middle -translate-y-px";

export const COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME =
  "inline-flex max-w-full select-none items-center gap-1 rounded-md bg-[var(--info-foreground)]/10 px-2 py-0.5 text-[var(--info-foreground)]/80 align-middle -translate-y-px";

export const COMPOSER_INLINE_SKILL_CHIP_ICON_CLASS_NAME = "size-3.5 shrink-0";

export const COMPOSER_INLINE_CHIP_ICON_CLASS_NAME = "size-3.5 shrink-0 opacity-85";

export const COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME = "size-4 shrink-0";

export const COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME = "truncate select-none leading-tight";

export const COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME =
  "ml-0.5 inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/72 transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export const COMPOSER_INLINE_SKILL_CHIP_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;

// Agent mention chip styling (for @alias syntax) - color applied dynamically per model
export const COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME =
  "inline-flex max-w-full select-none items-center gap-1 rounded-md px-1.5 py-0.5 align-middle text-[11px] font-medium";

export const COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME = "size-3 shrink-0";

// Formats raw skill ids like `check-code` into the label used by inline skill chips.
export function formatComposerSkillChipLabel(name: string): string {
  return name
    .split(/[-_]/)
    .map((segment) =>
      segment.length > 0 ? segment.charAt(0).toUpperCase() + segment.slice(1) : segment,
    )
    .join(" ");
}
