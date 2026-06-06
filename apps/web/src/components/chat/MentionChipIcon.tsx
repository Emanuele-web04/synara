// FILE: MentionChipIcon.tsx
// Purpose: Shared icon renderer for mention chips. Keeps file, folder, and
//          plugin glyphs identical between Lexical composer chips and React
//          sent-message chips.
// Layer: UI shared component/helper
// Exports: MentionChipIcon, createMentionChipIconElement

import { memo } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFileIconName, inferEntryKindFromPath } from "~/file-icons";
import { createCentralIconElement } from "~/lib/central-icons";
import { FileIcon, PluginIcon } from "~/lib/icons";
import { COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME } from "../composerInlineChip";
import { FolderClosed } from "../FolderClosed";
import { FileEntryIcon } from "./FileEntryIcon";

const FOLDER_CLOSED_ICON_SVG = renderToStaticMarkup(
  <FolderClosed aria-hidden="true" className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME} />,
);
const FILE_ICON_SVG = renderToStaticMarkup(
  <FileIcon aria-hidden="true" className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME} />,
);
const PLUGIN_ICON_SVG = renderToStaticMarkup(
  <PluginIcon aria-hidden="true" className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME} />,
);

export type MentionChipKind = "path" | "plugin";

function createStaticIconSpan(
  svg: string,
  className: string = COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME,
): HTMLSpanElement {
  const span = document.createElement("span");
  span.ariaHidden = "true";
  span.className = className;
  span.innerHTML = svg;
  return span;
}

// `theme` is retained for call-site compatibility but no longer affects icon
// selection (Central icons are theme-agnostic `currentColor` glyphs).
// `className` lets callers size the glyph per surface (composer token vs timeline
// echo) while keeping the file/folder/plugin selection logic in one place.
export const MentionChipIcon = memo(function MentionChipIcon(props: {
  path: string;
  theme: "light" | "dark";
  kind?: MentionChipKind;
  className?: string;
}) {
  const className = props.className ?? COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME;
  if (props.kind === "plugin" || props.path.startsWith("plugin://")) {
    return <PluginIcon className={className} />;
  }
  const kind = inferEntryKindFromPath(props.path);
  if (kind === "directory") {
    return <FolderClosed className={className} />;
  }
  // Delegate file rendering to FileEntryIcon so both surfaces resolve the same
  // Central icon (with the shared bracket fallback for unknown file types).
  return (
    <FileEntryIcon pathValue={props.path} kind={kind} theme={props.theme} className={className} />
  );
});

export function createMentionChipIconElement(
  path: string,
  kind: MentionChipKind = "path",
  className: string = COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME,
): HTMLElement {
  if (kind === "plugin" || path.startsWith("plugin://")) {
    return createStaticIconSpan(PLUGIN_ICON_SVG, className);
  }
  if (inferEntryKindFromPath(path) === "directory") {
    return createStaticIconSpan(FOLDER_CLOSED_ICON_SVG, className);
  }
  const iconElement = createCentralIconElement(getFileIconName(path), className);
  return iconElement ?? createStaticIconSpan(FILE_ICON_SVG, className);
}
