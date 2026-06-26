// FILE: DockExplorerPane.tsx
// Purpose: Right-dock pane that embeds the workspace file-tree explorer + file
//          search alongside the shared file viewer, mirroring the full editor
//          view's Files/Search activities inside the dock.
// Layer: Chat right-dock UI
// Exports: DockExplorerPane

import { memo, useCallback, useState } from "react";

import type { ChatFileReference } from "~/lib/chatReferences";
import type { FileCommentSelection } from "~/lib/fileComments";
import { FoldersIcon, SearchIcon } from "~/lib/icons";
import { WorkspaceFilePreview } from "../WorkspaceFilePreview";
import { PanelStateMessage } from "./PanelStateMessage";
import {
  ExplorerActivityBarButton,
  WorkspaceFilesSidebar,
  WorkspaceSearchSidebar,
} from "./workspaceExplorer";

type DockExplorerActivity = "files" | "search";

// The dock lays out as a fixed horizontal row, so the shared sidebars take a
// full-height fixed-width column (the editor's responsive default would collapse
// to a stacked block here).
const DOCK_EXPLORER_SIDEBAR_CLASS =
  "flex h-full min-h-0 w-52 shrink-0 flex-col border-r border-border/65 bg-[var(--color-background-surface)]";

export const DockExplorerPane = memo(function DockExplorerPane(props: {
  workspaceRoot: string | null;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  onCommentInChat?: ((comment: FileCommentSelection) => void) | undefined;
}) {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [activity, setActivity] = useState<DockExplorerActivity>("files");
  const [searchQuery, setSearchQuery] = useState("");
  // Re-clicking the active activity item collapses the sidebar so the viewer can
  // take the full pane width (VS Code style), matching the editor view.
  const [sidebarVisible, setSidebarVisible] = useState(true);

  const handleSelectActivity = useCallback(
    (next: DockExplorerActivity) => {
      if (sidebarVisible && activity === next) {
        setSidebarVisible(false);
        return;
      }
      setActivity(next);
      setSidebarVisible(true);
    },
    [activity, sidebarVisible],
  );

  const handleSelectFile = useCallback((path: string) => {
    setSelectedFilePath(path);
  }, []);

  const handleToggleDirectory = useCallback((path: string) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const filesActive = sidebarVisible && activity === "files";
  const searchActive = sidebarVisible && activity === "search";

  return (
    <div className="flex h-full min-h-0 w-full">
      <nav
        className="flex w-12 shrink-0 flex-col items-center border-r border-border/65 bg-[var(--color-background-surface)]"
        aria-label="Explorer activity bar"
      >
        <ExplorerActivityBarButton
          label={filesActive ? "Hide files sidebar" : "Files"}
          active={filesActive}
          onClick={() => handleSelectActivity("files")}
        >
          <FoldersIcon className="size-5" />
        </ExplorerActivityBarButton>
        <ExplorerActivityBarButton
          label={searchActive ? "Hide search sidebar" : "Search files"}
          active={searchActive}
          onClick={() => handleSelectActivity("search")}
        >
          <SearchIcon className="size-5" />
        </ExplorerActivityBarButton>
      </nav>
      {sidebarVisible ? (
        activity === "search" ? (
          <WorkspaceSearchSidebar
            workspaceRoot={props.workspaceRoot}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            selectedFilePath={selectedFilePath}
            containerClassName={DOCK_EXPLORER_SIDEBAR_CLASS}
            onSelectFile={handleSelectFile}
            onReferenceInChat={props.onReferenceInChat}
          />
        ) : (
          <WorkspaceFilesSidebar
            workspaceRoot={props.workspaceRoot}
            selectedFilePath={selectedFilePath}
            expandedDirectories={expandedDirectories}
            containerClassName={DOCK_EXPLORER_SIDEBAR_CLASS}
            onSelectFile={handleSelectFile}
            onToggleDirectory={handleToggleDirectory}
            onReferenceInChat={props.onReferenceInChat}
          />
        )
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        <WorkspaceFilePreview
          workspaceRoot={props.workspaceRoot}
          filePath={selectedFilePath}
          emptyState={
            <PanelStateMessage density="compact" fill="flex">
              <p>Select a file from the tree to view it.</p>
            </PanelStateMessage>
          }
          onReferenceInChat={props.onReferenceInChat}
          onAskWhyInChat={props.onAskWhyInChat}
          onCommentInChat={props.onCommentInChat}
        />
      </div>
    </div>
  );
});
