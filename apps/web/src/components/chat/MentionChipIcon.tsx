// FILE: MentionChipIcon.tsx
// Purpose: Shared icon renderer for mention chips. Keeps file, folder, and
//          plugin glyphs identical between Lexical composer chips and React
//          sent-message chips.
// Layer: UI shared component/helper
// Exports: MentionChipIcon, createMentionChipIconElement

import { memo } from "react";
import { getFileIconName, inferEntryKindFromPath } from "~/file-icons";
import { resolveMentionChipKind, type MentionChipKind } from "~/lib/composerMentions";
import { CentralIcon, createCentralIconElement } from "~/lib/central-icons";
import { PluginIcon } from "~/lib/icons";
import { COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME } from "../composerInlineChip";
import { FolderClosed } from "../FolderClosed";
import type { ProviderMentionReference } from "@synara/contracts";

export type { MentionChipKind };

function composerMentionChipCentralIconName(path: string, kind: MentionChipKind = "path"): string {
  if (kind === "plugin" || path.startsWith("plugin://")) {
    return "puzzle";
  }
  if (inferEntryKindFromPath(path) === "directory") {
    return "folder-2";
  }
  return getFileIconName(path);
}

// `theme` is retained for call-site compatibility but no longer affects icon
// selection (Central icons are theme-agnostic `currentColor` glyphs).
// `className` lets callers size the glyph per surface (composer token vs timeline
// echo) while keeping the file/folder/plugin selection logic in one place.
export const MentionChipIcon = memo(function MentionChipIcon(props: {
  path: string;
  theme: "light" | "dark";
  kind?: MentionChipKind;
  mentionReferences?: ReadonlyArray<ProviderMentionReference>;
  className?: string;
}) {
  const className = props.className ?? COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME;
  const resolvedKind = resolveMentionChipKind(props.path, {
    ...(props.kind ? { kind: props.kind } : {}),
    ...(props.mentionReferences ? { mentionReferences: props.mentionReferences } : {}),
  });
  if (resolvedKind === "plugin") {
    return <PluginIcon className={className} />;
  }
  const kind = inferEntryKindFromPath(props.path);
  if (kind === "directory") {
    return <FolderClosed className={className} />;
  }
  // Masked Central glyph painted with `bg-current`, so the file icon inherits the
  // chip's text color (it shares the filename's color) instead of a per-filetype
  // tint. `getFileIconName` already falls back to the bracket glyph when unknown.
  return <CentralIcon name={getFileIconName(props.path)} className={className} />;
});

// Lexical composer only — use a single masked Central icon (same as skill chips)
// so @ tokens align with / and $ tokens. User-message bubbles keep MentionChipIcon.
export function createMentionChipIconElement(
  path: string,
  kind: MentionChipKind = "path",
  className: string = COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME,
): HTMLElement {
  const iconName = composerMentionChipCentralIconName(path, kind);
  return (
    createCentralIconElement(iconName, className) ??
    createCentralIconElement("code-brackets", className) ??
    document.createElement("span")
  );
}
