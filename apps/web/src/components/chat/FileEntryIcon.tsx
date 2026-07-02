// FILE: FileEntryIcon.tsx
// Purpose: Shared file/folder glyph primitive for composer, diff, editor, and timeline rows.
// Layer: Chat/shared UI
// Exports: FileEntryIcon

import { memo } from "react";
import { getAttachmentIconName, getFileIconName } from "../../file-icons";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { FolderClosed, FolderOpen } from "../FolderClosed";

const FILE_ICON_COLOR_CLASS_BY_ICON_NAME: Record<string, string> = {
  audio: "text-[#38bdf8]",
  bun: "text-[#f4d7a1]",
  "calendar-days": "text-[#f59e0b]",
  c: "text-[#659ad2]",
  cmd: "text-[#4ade80]",
  "code-brackets": "text-[#9ca3af]",
  "file-jpg": "text-[#22c55e]",
  "file-pdf": "text-[#ef4444]",
  "file-png": "text-[#22c55e]",
  "file-text": "text-[#94a3b8]",
  "file-zip": "text-[#f97316]",
  "page-text": "text-[#94a3b8]",
  git: "text-[#f05032]",
  "image-alt-text": "text-[#22c55e]",
  java: "text-[#f89820]",
  javascript: "text-[#f7df1e]",
  json: "text-[#f5c542]",
  lock: "text-[#f59e0b]",
  markdown: "text-[#6cb6ff]",
  npm: "text-[#cb3837]",
  php: "text-[#777bb4]",
  phyton: "text-[#3776ab]",
  react: "text-[#61dafb]",
  rust: "text-[#dea584]",
  "settings-gear-1": "text-[#a78bfa]",
  svelte: "text-[#ff3e00]",
  typescript: "text-[#3178c6]",
  vercel: "text-foreground",
  video: "text-[#c084fc]",
  vue: "text-[#42b883]",
};

const FOLDER_ICON_COLOR_CLASS_NAME = "text-muted-foreground";

export const FileEntryIcon = memo(function FileEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  // When provided, the glyph is resolved attachment-style: the MIME type is
  // consulted whenever the filename has no recognizable extension, and the
  // fallback is a generic document rather than the source-code bracket. Left
  // undefined for source-file surfaces (diff/editor/timeline) that key purely
  // off the path.
  mimeType?: string | null | undefined;
  // Vestigial: Central icons are `currentColor` glyphs, so theme no longer
  // affects icon selection. Optional so theme-less surfaces (e.g. markdown
  // file links, code-block headers) can reuse this same primitive.
  theme?: "light" | "dark" | undefined;
  className?: string;
  // Timeline changed-file rows pass their own muted color and should not pick
  // up extension-specific colors.
  colorMode?: "file" | "inherit" | undefined;
  expanded?: boolean | undefined;
}) {
  // Match the look of the local filepath picker: directories always render the
  // outlined Central folder glyph.
  if (props.kind === "directory") {
    const FolderIcon = props.expanded ? FolderOpen : FolderClosed;
    return (
      <FolderIcon
        className={cn("size-4 shrink-0", props.className, FOLDER_ICON_COLOR_CLASS_NAME)}
      />
    );
  }

  const iconName =
    props.mimeType === undefined
      ? getFileIconName(props.pathValue)
      : getAttachmentIconName({ name: props.pathValue, mimeType: props.mimeType });
  const colorClassName =
    props.colorMode === "inherit"
      ? undefined
      : (FILE_ICON_COLOR_CLASS_BY_ICON_NAME[iconName] ??
        FILE_ICON_COLOR_CLASS_BY_ICON_NAME["code-brackets"]);

  return (
    <CentralIcon
      name={iconName}
      className={cn("size-4 shrink-0", props.className, colorClassName)}
    />
  );
});
