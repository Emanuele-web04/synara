// FILE: ProjectPicker.tsx
// Purpose: Folder selector beneath the new-chat composer that groups active folders and home
//          folders while always creating chats as rows inside the shared Chats container.
// Layer: Chat / empty-state entrypoint

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { type ProjectDirectoryEntry } from "@t3tools/contracts";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { createSidebarDisplayThreadsSelector } from "../../storeSelectors";
import { PlusIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { FolderClosed } from "../FolderClosed";
import { PickerTriggerButton } from "./PickerTriggerButton";
import { PickerPanelShell } from "./PickerPanelShell";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSeparator,
  ComboboxTrigger,
} from "../ui/combobox";
import { useWorkspaceStore } from "../../workspaceStore";

interface ProjectPickerProps {
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  showResetToHome?: boolean;
  selectedWorkspaceRoot?: string | null;
  onSelectWorkspaceRoot?: ((workspaceRoot: string) => void) | undefined;
  onResetToHome?: (() => void) | undefined;
}

interface ActiveFolderOption {
  cwd: string;
  primaryLabel: string;
  secondaryLabel: string | null;
}

function basenameOfPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const basename = separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
  return basename.length > 0 ? basename : null;
}

function directorySearchHaystack(entry: ProjectDirectoryEntry): string {
  return [entry.name, entry.path].join(" ").toLowerCase();
}

function joinDirectoryPath(rootPath: string, relativePath: string): string {
  if (!relativePath) return rootPath;
  const separator = rootPath.includes("\\") ? "\\" : "/";
  const normalizedRoot = rootPath.endsWith(separator) ? rootPath.slice(0, -1) : rootPath;
  const normalizedRelative = relativePath.split(/[\\/]+/).join(separator);
  return `${normalizedRoot}${separator}${normalizedRelative}`;
}

export const ProjectPicker = memo(function ProjectPicker({
  align = "start",
  side = "bottom",
  showResetToHome = false,
  selectedWorkspaceRoot = null,
  onSelectWorkspaceRoot,
  onResetToHome,
}: ProjectPickerProps) {
  const projects = useStore((state) => state.projects);
  const sidebarThreads = useStore(useMemo(() => createSidebarDisplayThreadsSelector(), []));
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [isPicking, setIsPicking] = useState(false);
  const [isLoadingDirectories, setIsLoadingDirectories] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [directoryEntries, setDirectoryEntries] = useState<readonly ProjectDirectoryEntry[]>([]);

  const activeFolderOptions = useMemo(() => {
    const seen = new Set<string>();
    const nextOptions: ActiveFolderOption[] = [];

    for (const project of projects.filter((project) => project.kind === "project")) {
      const folderName = basenameOfPath(project.cwd) ?? project.folderName ?? project.name;
      if (!folderName || folderName.startsWith(".") || seen.has(project.cwd)) {
        continue;
      }
      seen.add(project.cwd);
      const primaryLabel = project.localName?.trim() || folderName;
      const secondaryLabel =
        project.localName?.trim() && project.localName.trim() !== folderName ? folderName : null;
      nextOptions.push({ cwd: project.cwd, primaryLabel, secondaryLabel });
    }

    for (const thread of sidebarThreads) {
      const workspaceRoot = thread.worktreePath ?? null;
      const folderName = basenameOfPath(workspaceRoot);
      if (!workspaceRoot || !folderName || folderName.startsWith(".") || seen.has(workspaceRoot)) {
        continue;
      }
      seen.add(workspaceRoot);
      nextOptions.push({
        cwd: workspaceRoot,
        primaryLabel: folderName,
        secondaryLabel: null,
      });
    }

    const selectedFolderName = basenameOfPath(selectedWorkspaceRoot);
    if (
      selectedWorkspaceRoot &&
      selectedFolderName &&
      !selectedFolderName.startsWith(".") &&
      !seen.has(selectedWorkspaceRoot)
    ) {
      nextOptions.unshift({
        cwd: selectedWorkspaceRoot,
        primaryLabel: selectedFolderName,
        secondaryLabel: null,
      });
    }

    return nextOptions;
  }, [projects, selectedWorkspaceRoot, sidebarThreads]);
  const activeFolderPathSet = useMemo(
    () => new Set(activeFolderOptions.map((entry) => entry.cwd)),
    [activeFolderOptions],
  );
  const macFolderOptions = useMemo(
    () =>
      directoryEntries
        .filter((entry) => !entry.name.startsWith("."))
        .map((entry) => ({
          absolutePath: homeDir ? joinDirectoryPath(homeDir, entry.path) : entry.path,
          entry,
        }))
        .filter((entry) => !activeFolderPathSet.has(entry.absolutePath)),
    [activeFolderPathSet, directoryEntries, homeDir],
  );

  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredActiveFolderOptions = useMemo(() => {
    if (normalizedQuery.length === 0) return activeFolderOptions;
    return activeFolderOptions.filter((entry) =>
      [entry.primaryLabel, entry.secondaryLabel, entry.cwd]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [activeFolderOptions, normalizedQuery]);
  const filteredMacFolderOptions = useMemo(() => {
    if (normalizedQuery.length === 0) return macFolderOptions;
    return macFolderOptions.filter(({ entry }) =>
      directorySearchHaystack(entry).includes(normalizedQuery),
    );
  }, [macFolderOptions, normalizedQuery]);

  const selectableDirectoryPaths = useMemo(
    () => [
      ...activeFolderOptions.map((entry) => entry.cwd),
      ...macFolderOptions.map((entry) => entry.absolutePath),
    ],
    [activeFolderOptions, macFolderOptions],
  );
  const filteredDirectoryPaths = useMemo(
    () => [
      ...filteredActiveFolderOptions.map((entry) => entry.cwd),
      ...filteredMacFolderOptions.map((entry) => entry.absolutePath),
    ],
    [filteredActiveFolderOptions, filteredMacFolderOptions],
  );
  const selectedFolderOption = useMemo(() => {
    if (!selectedWorkspaceRoot) return null;
    return (
      activeFolderOptions.find((entry) => entry.cwd === selectedWorkspaceRoot) ??
      macFolderOptions
        .filter(({ absolutePath }) => absolutePath === selectedWorkspaceRoot)
        .map(({ entry, absolutePath }) => ({
          cwd: absolutePath,
          primaryLabel: entry.name,
          secondaryLabel: null,
        }))[0] ??
      null
    );
  }, [activeFolderOptions, macFolderOptions, selectedWorkspaceRoot]);
  const triggerLabel = selectedFolderOption ? (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate">{selectedFolderOption.primaryLabel}</span>
      {selectedFolderOption.secondaryLabel ? (
        <span className="min-w-0 truncate text-muted-foreground/60 text-xs">
          {selectedFolderOption.secondaryLabel}
        </span>
      ) : null}
    </span>
  ) : (
    "Work in a project"
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setErrorMessage(null);
    }
  }, []);

  useEffect(() => {
    if (!open || !homeDir || directoryEntries.length > 0 || isLoadingDirectories) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      setErrorMessage("App is still connecting. Try again in a moment.");
      return;
    }

    setIsLoadingDirectories(true);
    setErrorMessage(null);
    void api.projects
      .listDirectories({ cwd: homeDir })
      .then((result) => {
        setDirectoryEntries(
          result.entries.flatMap((entry) =>
            entry.kind === "directory"
              ? [
                  {
                    path: entry.path,
                    name: entry.name,
                    hasChildren: entry.hasChildren ?? false,
                    ...(entry.parentPath ? { parentPath: entry.parentPath } : {}),
                  } satisfies ProjectDirectoryEntry,
                ]
              : [],
          ),
        );
      })
      .catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : "Unable to load folders.");
      })
      .finally(() => {
        setIsLoadingDirectories(false);
      });
  }, [directoryEntries.length, homeDir, isLoadingDirectories, open]);

  const handleAddNewProject = useCallback(async () => {
    if (isPicking) return;
    const api = readNativeApi();
    if (!api) {
      setErrorMessage("App is still connecting. Try again in a moment.");
      return;
    }

    setIsPicking(true);
    setErrorMessage(null);
    try {
      const pickedPath = await api.dialogs.pickFolder();
      setIsPicking(false);
      if (!pickedPath) {
        return;
      }
      onSelectWorkspaceRoot?.(pickedPath);
      setOpen(false);
    } catch (error) {
      setIsPicking(false);
      setErrorMessage(error instanceof Error ? error.message : "Unable to open the folder picker.");
    }
  }, [isPicking, onSelectWorkspaceRoot]);

  return (
    <Combobox
      items={selectableDirectoryPaths}
      filteredItems={filteredDirectoryPaths}
      autoHighlight
      onOpenChange={handleOpenChange}
      open={open}
    >
      <ComboboxTrigger
        render={
          <PickerTriggerButton icon={<FolderClosed className="size-3.5" />} label={triggerLabel} />
        }
      />
      <ComboboxPopup align={align} side={side} className="p-0">
        <PickerPanelShell
          searchPlaceholder="Search projects"
          query={query}
          onQueryChange={setQuery}
          footer={
            <>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void handleAddNewProject()}
                disabled={isPicking}
              >
                <PlusIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                <span className="truncate">
                  {isPicking ? "Opening folder picker…" : "Add new project"}
                </span>
              </button>
              {showResetToHome ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent"
                  onClick={() => {
                    onResetToHome?.();
                    setOpen(false);
                  }}
                >
                  <XIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <span className="truncate">Don&apos;t work in a project</span>
                </button>
              ) : null}
              {errorMessage ? (
                <div className="px-2 pb-1 text-destructive text-xs">{errorMessage}</div>
              ) : null}
            </>
          }
        >
          <ComboboxEmpty>
            {isLoadingDirectories
              ? "Loading folders…"
              : activeFolderOptions.length === 0 && macFolderOptions.length === 0
                ? "No folders found"
                : "No matches"}
          </ComboboxEmpty>
          <ComboboxList className="max-h-64">
            {filteredActiveFolderOptions.length > 0 ? (
              <ComboboxGroup>
                <ComboboxGroupLabel>Active folders</ComboboxGroupLabel>
                {filteredActiveFolderOptions.map((folder, index) => (
                  <ComboboxItem
                    hideIndicator={folder.cwd !== selectedWorkspaceRoot}
                    key={folder.cwd}
                    index={index}
                    value={folder.cwd}
                    onClick={() => {
                      onSelectWorkspaceRoot?.(folder.cwd);
                      setOpen(false);
                    }}
                    className={cn(
                      folder.cwd === selectedWorkspaceRoot && "bg-accent/40 text-accent-foreground",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <FolderClosed className="size-3.5 shrink-0 text-muted-foreground/70" />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-baseline gap-1.5">
                          <span className="min-w-0 truncate">{folder.primaryLabel}</span>
                          {folder.secondaryLabel ? (
                            <span className="min-w-0 truncate text-muted-foreground/60 text-xs">
                              {folder.secondaryLabel}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </ComboboxItem>
                ))}
              </ComboboxGroup>
            ) : null}
            {filteredActiveFolderOptions.length > 0 && filteredMacFolderOptions.length > 0 ? (
              <ComboboxSeparator />
            ) : null}
            {filteredMacFolderOptions.length > 0 ? (
              <ComboboxGroup>
                <ComboboxGroupLabel>Folders on this Mac</ComboboxGroupLabel>
                {filteredMacFolderOptions.map(({ absolutePath, entry }, index) => (
                  <ComboboxItem
                    hideIndicator={absolutePath !== selectedWorkspaceRoot}
                    key={absolutePath}
                    index={filteredActiveFolderOptions.length + index}
                    value={absolutePath}
                    onClick={() => {
                      onSelectWorkspaceRoot?.(absolutePath);
                      setOpen(false);
                    }}
                    className={cn(
                      absolutePath === selectedWorkspaceRoot &&
                        "bg-accent/40 text-accent-foreground",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <FolderClosed className="size-3.5 shrink-0 text-muted-foreground/70" />
                      <span className="truncate">{entry.name}</span>
                    </div>
                  </ComboboxItem>
                ))}
              </ComboboxGroup>
            ) : null}
          </ComboboxList>
        </PickerPanelShell>
      </ComboboxPopup>
    </Combobox>
  );
});
