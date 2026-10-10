// tune via the base class for shared font/size and the fill/tone maps for variants

import { cn } from "~/lib/utils";
import {
  COMPOSER_EDITOR_LINE_HEIGHT_CLASS_NAME,
  COMPOSER_EDITOR_TEXT_CLASS_NAME,
} from "./chat/composerPickerStyles";

// one gap token for block sides and icon→label inside the block
export const COMPOSER_INLINE_CHIP_SIDE_GAP_CLASS_NAME = "mx-0.5";
export const COMPOSER_INLINE_CHIP_ICON_LABEL_GAP_CLASS_NAME = "mr-1";

// plain inline flow (not inline-flex) so parsed tokens share the line box / caret strut of typed text; icons are inline-block at 1em
export const COMPOSER_INLINE_CHIP_BASE_CLASS_NAME = cn(
  "inline max-w-full select-none align-baseline font-medium",
  COMPOSER_INLINE_CHIP_SIDE_GAP_CLASS_NAME,
  COMPOSER_EDITOR_TEXT_CLASS_NAME,
  COMPOSER_EDITOR_LINE_HEIGHT_CLASS_NAME,
);

/** Lexical inline-decorator host — no extra layout; the nested chip owns typography. */
export const COMPOSER_INLINE_DECORATOR_HOST_CLASS_NAME = "inline";

// `plain` = in-composer look, no background, sits inline with typed text; `soft` = tinted pill when a token is echoed inside a sent message
export type ComposerInlineChipFill = "plain" | "soft";
// `accent` → skill + file/folder/plugin tokens (shared info color).
// `neutral` → generic tokens (foreground color).
export type ComposerInlineChipTone = "accent" | "neutral";

const COMPOSER_INLINE_CHIP_FILL_CLASS_NAME: Record<ComposerInlineChipFill, string> = {
  plain: "",
  soft: "rounded-md px-2 py-0.5 -translate-y-px",
};

const COMPOSER_INLINE_CHIP_TONE_TEXT_CLASS_NAME: Record<ComposerInlineChipTone, string> = {
  accent: "text-[var(--info-foreground)]",
  neutral: "text-[var(--color-text-foreground)]",
};

// Background tint for `soft` fill, kept in the same family as the tone color.
const COMPOSER_INLINE_CHIP_TONE_SOFT_BG_CLASS_NAME: Record<ComposerInlineChipTone, string> = {
  accent: "bg-[var(--info)]/10",
  neutral: "bg-[var(--sidebar-accent-active)]",
};

/** Builds an inline chip class from the shared base plus a fill + tone variant. */
export function composerInlineChipClassName(options?: {
  fill?: ComposerInlineChipFill;
  tone?: ComposerInlineChipTone;
  className?: string;
}): string {
  const fill = options?.fill ?? "plain";
  const tone = options?.tone ?? "accent";
  return cn(
    COMPOSER_INLINE_CHIP_BASE_CLASS_NAME,
    COMPOSER_INLINE_CHIP_TONE_TEXT_CLASS_NAME[tone],
    COMPOSER_INLINE_CHIP_FILL_CLASS_NAME[fill],
    fill === "soft" ? COMPOSER_INLINE_CHIP_TONE_SOFT_BG_CLASS_NAME[tone] : null,
    options?.className,
  );
}

/** Plain accent token shared by skill + file/folder/plugin mentions in the editor. */
export const COMPOSER_EDITOR_INLINE_CHIP_CLASS_NAME = composerInlineChipClassName({
  fill: "plain",
  tone: "accent",
});

/** Tappable link token (bare URL / shortened GitHub reference). Shares the
 *  plain accent look of the other inline tokens, adding pointer affordance and a
 *  hover underline so it reads as openable in both the composer and timeline. */
export const COMPOSER_INLINE_LINK_CHIP_CLASS_NAME = composerInlineChipClassName({
  fill: "plain",
  tone: "accent",
  // `text-left` resets the UA <button> default centering, which otherwise centers a wrapped URL label in the timeline chip
  className: "cursor-pointer text-left hover:underline",
});

/** Leading icon for markdown links and inline chips — 1em tall, middle-aligned to label text. */
export const COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME =
  "inline-block size-[1em] shrink-0 align-middle -translate-y-px";
/** Composer / timeline inline chips — same glyph metrics, gap before the label. */
export const COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME = cn(
  COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_LABEL_GAP_CLASS_NAME,
);
export const COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME = "inline select-none";

export const COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME = cn(
  "inline-flex max-w-full select-none items-center gap-0.5 font-medium rounded-md px-1.5 py-0.5 align-baseline",
  COMPOSER_INLINE_CHIP_SIDE_GAP_CLASS_NAME,
  COMPOSER_EDITOR_TEXT_CLASS_NAME,
  COMPOSER_EDITOR_LINE_HEIGHT_CLASS_NAME,
);
export const COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME = "size-3 shrink-0";

// single source of truth for agent-token colors (composer chip + timeline echo): inline rgb tokens keyed by assigned color name
export interface AgentChipColor {
  readonly bg: string;
  readonly text: string;
}
export const DEFAULT_AGENT_CHIP_COLOR: AgentChipColor = {
  bg: "rgb(245 158 11 / 0.15)",
  text: "rgb(245 158 11)",
};
const AGENT_CHIP_COLOR_BY_NAME: Record<string, AgentChipColor> = {
  violet: { bg: "rgb(139 92 246 / 0.15)", text: "rgb(139 92 246)" },
  fuchsia: { bg: "rgb(217 70 239 / 0.15)", text: "rgb(217 70 239)" },
  teal: { bg: "rgb(20 184 166 / 0.15)", text: "rgb(20 184 166)" },
  cyan: { bg: "rgb(6 182 212 / 0.15)", text: "rgb(6 182 212)" },
  amber: DEFAULT_AGENT_CHIP_COLOR,
  orange: { bg: "rgb(249 115 22 / 0.15)", text: "rgb(249 115 22)" },
};
export function resolveAgentChipColor(color: string | undefined): AgentChipColor {
  return (color ? AGENT_CHIP_COLOR_BY_NAME[color] : undefined) ?? DEFAULT_AGENT_CHIP_COLOR;
}

// mirror the in-composer chip exactly (plain, accent, no fill) so a sent token reads identically to how it looked while typing
export const COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME = COMPOSER_EDITOR_INLINE_CHIP_CLASS_NAME;
export const COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME = COMPOSER_EDITOR_INLINE_CHIP_CLASS_NAME;
export const COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME =
  COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME;

/** Openable file-mention chip (assistant markdown links). Same plain accent look
 *  as a static mention chip, plus pointer affordance + hover underline so it
 *  reads as clickable while keeping the file icon + medium label treatment. */
export const COMPOSER_INLINE_MENTION_CHIP_INTERACTIVE_CLASS_NAME = composerInlineChipClassName({
  fill: "plain",
  tone: "accent",
  className: "cursor-pointer text-left hover:underline",
});

// ── Composer attachment chips (image / selection / terminal context) ── Bordered shell used by attachment-style chips (distinct from inline tokens).
export const COMPOSER_INLINE_CHIP_CLASS_NAME =
  "inline-flex max-w-full select-none items-center gap-0.5 rounded border border-[color:var(--color-border-light)] bg-[var(--sidebar-accent-active)] p-0.5 font-medium text-ui-sm leading-[1.1] text-[var(--color-text-foreground)] align-middle";

export const COMPOSER_INLINE_CHIP_ICON_CLASS_NAME = "size-3.5 shrink-0 opacity-85";

export const COMPOSER_ATTACHMENT_CHIP_CLASS_NAME =
  "inline-flex min-w-0 max-w-full items-center gap-0.5 rounded-full border border-[color:var(--color-border)] bg-[var(--composer-surface)] p-px text-ui-sm font-medium text-[var(--color-text-foreground)]";

/** Central icon basename shared by every skill token (editor + timeline). */
export const COMPOSER_INLINE_SKILL_CHIP_ICON_NAME = "building-blocks";

function formatComposerInlineTokenLabel(name: string): string {
  return name
    .split(/[-_]/)
    .map((segment) =>
      segment.length > 0 ? segment.charAt(0).toUpperCase() + segment.slice(1) : segment,
    )
    .join(" ");
}

// Formats raw skill ids like `check-code` into the label used by inline skill chips.
export function formatComposerSkillChipLabel(name: string): string {
  return formatComposerInlineTokenLabel(name);
}

export function formatComposerSlashCommandChipLabel(command: string): string {
  return formatComposerInlineTokenLabel(command);
}
