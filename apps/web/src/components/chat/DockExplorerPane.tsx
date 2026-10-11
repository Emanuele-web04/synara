// FILE: DockExplorerPane.tsx
// Purpose: Right-dock pane that embeds the unified workspace explorer (a fixed
//          search box over the file tree, switching to file-name results as the
//          user types) alongside the shared file viewer.
// Layer: Chat right-dock UI
// Exports: DockExplorerPane

import { useEffect, useRef } from "react";

import type { ThreadId } from "@synara/contracts";
import { isNormalizedWindowsAbsolutePath } from "@synara/shared/path";
import { useQueryClient } from "@tanstack/react-query";

import {
  selectDockExplorerBrowseState,
  useDockExplorerBrowseStore,
} from "~/dockExplorerBrowseStore";
import { directoryChain, useExplorerRevealRequestStore } from "~/explorerRevealRequestStore";
import type { ChatFileReference } from "~/lib/chatReferences";
import type { FileCommentSelection } from "~/lib/fileComments";
import { projectListDirectoriesQueryOptions } from "~/lib/projectReactQuery";
import { flushWorkspaceEditors } from "~/lib/workspaceEditorSession";
import { WorkspaceFilePreview } from "../WorkspaceFilePreview";
import { PanelStateMessage } from "./PanelStateMessage";
import { WorkspaceExplorerSidebar } from "./workspaceExplorer";

// The dock lays out as a fixed horizontal row, so the shared sidebar takes a
// full-height fixed-width column (the editor's responsive default would collapse
// to a stacked block here). With the activity rail gone, the search box sits at
// the top of this column and the freed width goes to the file viewer.
const DOCK_EXPLORER_SIDEBAR_CLASS =
  "flex h-full min-h-0 w-60 shrink-0 flex-col border-r border-border/65 app-content-surface";

export const DockExplorerPane = function DockExplorerPane(props: {
  threadId: ThreadId;
  workspaceRoot: string | null;
  isVisible: boolean;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  onCommentInChat?: ((comment: FileCommentSelection) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  // Browse state lives in the per-thread store, not component state: the pane
  // unmounts on a thread switch and remounts on return, so useState here would
  // reset the selected file, expanded directories, and search query every time.
  const { selectedFilePath, expandedDirectories, searchQuery } = useDockExplorerBrowseStore(
    selectDockExplorerBrowseState(props.threadId),
  );

  // Reveal requests (e.g. picking a folder in the Cmd+P palette) expand the
  // full ancestor chain and clear any name filter so the tree is what shows.
  const revealRequest = useExplorerRevealRequestStore(
    (state) => state.requestsByThreadId[props.threadId],
  );
  useEffect(() => {
    if (!revealRequest) return;
    useDockExplorerBrowseStore.getState().setSearchQuery(props.threadId, "");
    const workspaceRoot = props.workspaceRoot;
    let cancelled = false;
    const expand = (paths: string[]) => {
      if (cancelled) return;
      useDockExplorerBrowseStore.getState().expandDirectories(props.threadId, paths);
    };
    if (!workspaceRoot || !isNormalizedWindowsAbsolutePath(workspaceRoot.replaceAll("\\", "/"))) {
      expand(directoryChain(revealRequest.path));
      return;
    }

    // Windows links may use different casing from the actual entries. Resolve
    // only the requested ancestor chain through the tree's shared query cache
    // so expansion and manual toggles use the same canonical entry.path keys.
    const reveal = async () => {
      let parentPath = "";
      const paths: string[] = [];
      for (const segment of revealRequest.path.split("/").filter(Boolean)) {
        const listing = await queryClient.fetchQuery(
          projectListDirectoriesQueryOptions({ cwd: workspaceRoot, relativePath: parentPath }),
        );
        if (cancelled) return;
        const entry = listing.entries.find(
          (candidate) =>
            candidate.kind === "directory" &&
            candidate.name.toLowerCase() === segment.toLowerCase(),
        );
        if (!entry) break;
        parentPath = entry.path;
        paths.push(parentPath);
      }
      expand(paths);
    };
    // A failed listing must not mark a guessed path expanded or disturb the
    // current tree state.
    void reveal().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [revealRequest, props.workspaceRoot, props.threadId, queryClient]);

  const selectionRequestRef = useRef(0);
  const handleSelectFile = (path: string) => {
    const request = ++selectionRequestRef.current;
    void flushWorkspaceEditors(queryClient, props.workspaceRoot).then((saved) => {
      if (saved && request === selectionRequestRef.current) {
        useDockExplorerBrowseStore.getState().selectFile(props.threadId, path);
      }
    });
  };

  const handleToggleDirectory = (path: string) => {
    useDockExplorerBrowseStore.getState().toggleDirectory(props.threadId, path);
  };

  const handleQueryChange = (query: string) => {
    useDockExplorerBrowseStore.getState().setSearchQuery(props.threadId, query);
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      <WorkspaceExplorerSidebar
        workspaceRoot={props.workspaceRoot}
        selectedFilePath={selectedFilePath}
        expandedDirectories={expandedDirectories}
        query={searchQuery}
        onQueryChange={handleQueryChange}
        containerClassName={DOCK_EXPLORER_SIDEBAR_CLASS}
        onSelectFile={handleSelectFile}
        onToggleDirectory={handleToggleDirectory}
        onReferenceInChat={props.onReferenceInChat}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <WorkspaceFilePreview
          workspaceRoot={props.workspaceRoot}
          filePath={selectedFilePath}
          liveRevalidationEnabled={props.isVisible}
          editable
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
};
