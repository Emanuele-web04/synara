import { memo, useMemo, useState } from "react";
import { getFileIconUrlForEntry } from "../../file-icons";
import { FileIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { FolderClosed } from "../FolderClosed";

export const FileEntryIcon = memo(function FileEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  theme: "light" | "dark";
  className?: string;
}) {
  // Match the look of the local filepath picker: directories always render the
  // outlined FolderClosed glyph rather than an extra network fetch to Seti.
  if (props.kind === "directory") {
    return (
      <FolderClosed className={cn("size-4 shrink-0 text-muted-foreground/70", props.className)} />
    );
  }

  return (
    <FileIconImage
      pathValue={props.pathValue}
      theme={props.theme}
      className={props.className ?? ""}
    />
  );
});

const FileIconImage = memo(function FileIconImage(props: {
  pathValue: string;
  theme: "light" | "dark";
  className: string;
}) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const iconUrl = useMemo(
    () => getFileIconUrlForEntry(props.pathValue, "file", props.theme),
    [props.pathValue, props.theme],
  );

  if (failedIconUrl === iconUrl) {
    return <FileIcon className={cn("size-4 text-muted-foreground/80", props.className)} />;
  }

  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className={cn("size-4 shrink-0", props.className)}
      loading="lazy"
      onError={() => setFailedIconUrl(iconUrl)}
    />
  );
});
