// FILE: MentionChipIcon.tsx
// Purpose: Shared icon renderer for file/folder mention chips. Picks between
//          the outlined folder glyph and the Central file-type icon so the
//          composer Lexical chip (DOM) and the sent-message chip (React)
//          stay in sync.
// Layer: UI shared component/helper
// Exports: MentionChipIcon, createMentionChipIconElement

import { memo } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFileIconName, inferEntryKindFromPath } from "~/file-icons";
import { createCentralIconElement } from "~/lib/central-icons";
import { FileIcon, PlugIcon } from "~/lib/icons";
import { COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME } from "../composerInlineChip";
import { FolderClosed } from "../FolderClosed";
import { FileEntryIcon } from "./FileEntryIcon";

const FOLDER_CLOSED_ICON_SVG = renderToStaticMarkup(
  <FolderClosed aria-hidden="true" className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME} />,
);
const FILE_ICON_SVG = renderToStaticMarkup(
  <FileIcon aria-hidden="true" className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME} />,
);
const PLUG_ICON_SVG = renderToStaticMarkup(
  <PlugIcon aria-hidden="true" className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME} />,
);

export type MentionChipKind = "path" | "plugin";

function createStaticIconSpan(svg: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.ariaHidden = "true";
  span.className = COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME;
  span.innerHTML = svg;
  return span;
}

// `theme` is retained for call-site compatibility but no longer affects icon
// selection (Central icons are theme-agnostic `currentColor` glyphs).
export const MentionChipIcon = memo(function MentionChipIcon(props: {
  path: string;
  theme: "light" | "dark";
  kind?: MentionChipKind;
}) {
  if (props.kind === "plugin" || props.path.startsWith("plugin://")) {
    return <PlugIcon className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME} />;
  }
  const kind = inferEntryKindFromPath(props.path);
  if (kind === "directory") {
    return <FolderClosed className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME} />;
  }
  // Delegate file rendering to FileEntryIcon so both surfaces resolve the same
  // Central icon (with the shared bracket fallback for unknown file types).
  return (
    <FileEntryIcon
      pathValue={props.path}
      kind={kind}
      theme={props.theme}
      className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME}
    />
  );
});

export function createMentionChipIconElement(
  path: string,
  kind: MentionChipKind = "path",
): HTMLElement {
  if (kind === "plugin" || path.startsWith("plugin://")) {
    return createStaticIconSpan(PLUG_ICON_SVG);
  }
  if (inferEntryKindFromPath(path) === "directory") {
    return createStaticIconSpan(FOLDER_CLOSED_ICON_SVG);
  }
  const iconElement = createCentralIconElement(
    getFileIconName(path),
    COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME,
  );
  return iconElement ?? createStaticIconSpan(FILE_ICON_SVG);
}
