// FILE: MentionChipIcon.tsx
// Purpose: Shared icon renderer for file/folder mention chips. Picks between
//          the outlined folder glyph and the Seti file-type icon so the
//          composer Lexical chip (DOM) and the sent-message chip (React)
//          stay in sync.
// Layer: UI shared component/helper
// Exports: MentionChipIcon, createMentionChipIconElement

import { memo } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFileIconUrlForEntry, inferEntryKindFromPath } from "~/file-icons";
import { COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME } from "../composerInlineChip";
import { FolderClosed } from "../FolderClosed";
import { FileEntryIcon } from "./FileEntryIcon";

const FOLDER_CLOSED_ICON_SVG = renderToStaticMarkup(
  <FolderClosed aria-hidden="true" className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME} />,
);

export const MentionChipIcon = memo(function MentionChipIcon(props: {
  path: string;
  theme: "light" | "dark";
}) {
  const kind = inferEntryKindFromPath(props.path);
  if (kind === "directory") {
    return <FolderClosed className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME} />;
  }
  // Delegate file rendering to FileEntryIcon so we inherit the onError
  // fallback that swaps to the Lucide FileIcon if the Seti asset is missing.
  return (
    <FileEntryIcon
      pathValue={props.path}
      kind={kind}
      theme={props.theme}
      className={COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME}
    />
  );
});

export function createMentionChipIconElement(path: string, theme: "light" | "dark"): HTMLElement {
  if (inferEntryKindFromPath(path) === "directory") {
    const span = document.createElement("span");
    span.ariaHidden = "true";
    span.className = COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME;
    span.innerHTML = FOLDER_CLOSED_ICON_SVG;
    return span;
  }
  const image = document.createElement("img");
  image.alt = "";
  image.ariaHidden = "true";
  image.className = COMPOSER_INLINE_MENTION_CHIP_ICON_CLASS_NAME;
  image.loading = "lazy";
  image.src = getFileIconUrlForEntry(path, "file", theme);
  return image;
}
