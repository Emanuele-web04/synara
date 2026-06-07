import { memo } from "react";
import { getFileIconName } from "../../file-icons";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { FolderClosed } from "../FolderClosed";

// `theme` is retained on the props for call-site compatibility (it still drives
// diff/theme behavior in the surrounding panels) but no longer affects icon
// selection: Central icons are monochrome `currentColor` glyphs rendered via CSS
// mask, so they inherit the surrounding text color on both light and dark.
export const FileEntryIcon = memo(function FileEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  theme: "light" | "dark";
  className?: string;
}) {
  // Match the look of the local filepath picker: directories always render the
  // outlined FolderClosed glyph.
  if (props.kind === "directory") {
    return (
      <FolderClosed className={cn("size-4 shrink-0 text-muted-foreground/70", props.className)} />
    );
  }

  return (
    <CentralIcon
      name={getFileIconName(props.pathValue)}
      className={cn("size-4 shrink-0", props.className)}
    />
  );
});
