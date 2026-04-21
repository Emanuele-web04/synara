// FILE: DirectoryTreePicker.tsx
// Purpose: Reusable lazy folder-tree picker rooted at a caller-provided filesystem path.
// Layer: Chat/home input helper
// Depends on: native project directory API, shared popover/button primitives, and folder icons.

import type { ProjectDirectoryEntry } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { memo, useCallback, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon } from "~/lib/icons";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

interface DirectoryTreePickerProps {
  rootPath: string | null;
  triggerLabel: string;
  emptyLabel?: string;
  onSelectDirectory: (absolutePath: string, entry: ProjectDirectoryEntry) => Promise<void> | void;
}

type DirectoryEntriesByParent = Record<string, readonly ProjectDirectoryEntry[] | undefined>;

function joinDirectoryPath(rootPath: string, relativePath: string): string {
  if (!relativePath) return rootPath;
  const separator = rootPath.includes("\\") ? "\\" : "/";
  const normalizedRoot = rootPath.endsWith(separator) ? rootPath.slice(0, -1) : rootPath;
  const normalizedRelative = relativePath.split(/[\\/]+/).join(separator);
  return `${normalizedRoot}${separator}${normalizedRelative}`;
}

export const DirectoryTreePicker = memo(function DirectoryTreePicker({
  rootPath,
  triggerLabel,
  emptyLabel = "No folders found",
  onSelectDirectory,
}: DirectoryTreePickerProps) {
  const [open, setOpen] = useState(false);
  const [entriesByParent, setEntriesByParent] = useState<DirectoryEntriesByParent>({});
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const rootEntries = entriesByParent[""] ?? [];

  const loadDirectory = useCallback(
    async (relativePath = "") => {
      const api = readNativeApi();
      if (!api || !rootPath) {
        return;
      }
      if (entriesByParent[relativePath]) {
        return;
      }

      setLoadingPaths((current) => new Set(current).add(relativePath));
      setErrorMessage(null);
      try {
        const result = await api.projects.listDirectories({
          cwd: rootPath,
          ...(relativePath ? { relativePath } : {}),
        });
        setEntriesByParent((current) => ({
          ...current,
          [relativePath]: result.entries,
        }));
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Unable to load folders.");
      } finally {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(relativePath);
          return next;
        });
      }
    },
    [entriesByParent, rootPath],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen && rootEntries.length === 0 && !loadingPaths.has("")) {
        void loadDirectory();
      }
    },
    [loadDirectory, loadingPaths, rootEntries.length],
  );

  const toggleDirectory = useCallback(
    (entry: ProjectDirectoryEntry) => {
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(entry.path)) {
          next.delete(entry.path);
          return next;
        }
        next.add(entry.path);
        return next;
      });
      if (entry.hasChildren && !entriesByParent[entry.path]) {
        void loadDirectory(entry.path);
      }
    },
    [entriesByParent, loadDirectory],
  );

  const renderedTree = useMemo(() => {
    // Mirror Codex neutral picker rows so the directory browser doesn't reintroduce accent hover.
    const renderEntries = (entries: readonly ProjectDirectoryEntry[], depth: number): ReactNode[] =>
      entries.flatMap((entry) => {
        const expanded = expandedPaths.has(entry.path);
        const children = entriesByParent[entry.path] ?? [];
        const isLoadingChildren = loadingPaths.has(entry.path);

        return [
          <div
            key={entry.path}
            className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-sm transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
            style={{ paddingLeft: `${8 + depth * 16}px` }}
          >
            <button
              type="button"
              aria-label={expanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-[var(--color-background-button-secondary)] hover:text-foreground",
                !entry.hasChildren && "opacity-35",
              )}
              onClick={() => {
                if (entry.hasChildren) {
                  toggleDirectory(entry);
                }
              }}
            >
              {entry.hasChildren ? (
                expanded ? (
                  <ChevronDownIcon className="size-3.5" />
                ) : (
                  <ChevronRightIcon className="size-3.5" />
                )
              ) : null}
            </button>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left"
              onClick={() => {
                if (!rootPath) return;
                void onSelectDirectory(joinDirectoryPath(rootPath, entry.path), entry);
                setOpen(false);
              }}
            >
              <FolderIcon className="size-4 shrink-0 text-muted-foreground/70" />
              <span className="truncate text-foreground/88">{entry.name}</span>
            </button>
            {isLoadingChildren ? (
              <span className="shrink-0 text-[11px] text-muted-foreground/45">Loading…</span>
            ) : null}
          </div>,
          ...(expanded && children.length > 0 ? renderEntries(children, depth + 1) : []),
        ];
      });

    return renderEntries(rootEntries, 0);
  }, [
    entriesByParent,
    expandedPaths,
    loadingPaths,
    onSelectDirectory,
    rootEntries,
    rootPath,
    toggleDirectory,
  ]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
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
        <div className="max-h-[24rem] overflow-auto px-2 py-2">
          {!rootPath ? (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground/60">
              Home directory unavailable.
            </div>
          ) : loadingPaths.has("") && rootEntries.length === 0 ? (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground/60">
              Loading folders…
            </div>
          ) : renderedTree.length > 0 ? (
            renderedTree
          ) : (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground/60">
              {emptyLabel}
            </div>
          )}
          {errorMessage ? (
            <div className="px-2 pt-2 text-xs text-red-400">{errorMessage}</div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
