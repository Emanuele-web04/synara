// FILE: DirectoryTreePicker.tsx
// Purpose: Wrap the shared directory browser in a button-triggered popover picker.
// Layer: Chat/home input helper
// Depends on: DirectoryTreeBrowser and shared popover/button primitives.

import type { ProjectDirectoryEntry, ProjectFileSystemEntry } from "@t3tools/contracts";
import { memo, useState } from "react";
import { FolderIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { DirectoryTreeBrowser } from "./DirectoryTreeBrowser";

interface DirectoryTreePickerProps {
  rootPath: string | null;
  triggerLabel: string;
  emptyLabel?: string;
  includeFiles?: boolean;
  onSelectDirectory: (absolutePath: string, entry: ProjectDirectoryEntry) => Promise<void> | void;
}

export const DirectoryTreePicker = memo(function DirectoryTreePicker({
  rootPath,
  triggerLabel,
  emptyLabel = "No folders found",
  includeFiles = false,
  onSelectDirectory,
}: DirectoryTreePickerProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" size="sm" />}>
        <FolderIcon className="size-4" />
        <span>{triggerLabel}</span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[min(32rem,calc(100vw-2rem))] p-0">
        <div className="border-b border-border/60 px-4 py-3">
          <p className="text-sm font-medium text-foreground">Start a chat from a folder</p>
          <p className="mt-1 truncate text-xs text-muted-foreground/60">
            {rootPath ?? "No home directory found"}
          </p>
        </div>
        <DirectoryTreeBrowser
          rootPath={rootPath}
          emptyLabel={emptyLabel}
          unavailableLabel="Home directory unavailable."
          loadingLabel={includeFiles ? "Loading entries…" : "Loading folders…"}
          className="max-h-[24rem] overflow-auto px-2 py-2"
          includeFiles={includeFiles}
          onSelectEntry={async (absolutePath, entry: ProjectFileSystemEntry) => {
            if (entry.kind !== "directory") {
              return;
            }
            await onSelectDirectory(absolutePath, {
              path: entry.path,
              name: entry.name,
              hasChildren: entry.hasChildren ?? false,
              ...(entry.parentPath ? { parentPath: entry.parentPath } : {}),
            });
            setOpen(false);
          }}
        />
      </PopoverPopup>
    </Popover>
  );
});
