// FILE: DiffPanelFileList.tsx
// Purpose: Memoized multi-file diff list for the review panel — isolates @pierre/diffs
//          rendering from chat-stream re-renders in the parent DiffPanel shell.
// Layer: Diff panel UI

import type { FileDiffMetadata } from "@pierre/diffs/react";
import { isSupportedLocalImagePath } from "@synara/shared/localPreviewFiles";
import { memo, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDownIcon, CopyIcon, EllipsisIcon, MessageCircleIcon } from "~/lib/icons";

import { buildFileDiffRenderKey, resolveFileDiffPath } from "~/lib/diffRendering";
import { FileDiffCard, FileDiffSurface } from "./chat/FileDiffView";
import { LocalImagePreview } from "./LocalImagePreview";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { IconButton } from "./ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "./ui/menu";

type DiffRenderMode = "stacked" | "split";

export interface DiffFileChatActions {
  onReferenceInChat: (filePath: string) => void;
  onAskWhyChanged: (filePath: string) => void;
}

const DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground";

// Per-file actions menu rendered in the custom header's trailing slot, left of
// the collapse chevron. Marked with data-diff-header-menu so header clicks on
// it do not toggle the file collapse state.
function DiffFileHeaderActionsMenu(props: { filePath: string; chatActions: DiffFileChatActions }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            variant="ghost"
            size="icon-xs"
            label="File actions"
            title="File actions"
            className="text-muted-foreground hover:text-foreground"
          >
            <EllipsisIcon className="size-3.5" />
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={6} className="w-60 min-w-60">
        <MenuItem
          onClick={() => {
            props.chatActions.onReferenceInChat(props.filePath);
          }}
        >
          <MessageCircleIcon className={DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME} />
          <span>Reference in chat</span>
        </MenuItem>
        <MenuItem
          onClick={() => {
            props.chatActions.onAskWhyChanged(props.filePath);
          }}
        >
          <MessageCircleIcon className={DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME} />
          <span>Ask why this changed</span>
        </MenuItem>
        <MenuItem
          onClick={() => {
            void navigator.clipboard?.writeText(props.filePath);
          }}
        >
          <CopyIcon className={DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME} />
          <span>Copy path</span>
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function DiffFileCollapseChevron(props: { collapsed: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px",
        color: "inherit",
      }}
    >
      <ChevronDownIcon
        style={{
          width: "14px",
          height: "14px",
          transition: "transform 150ms ease",
          transform: props.collapsed ? "rotate(-90deg)" : "rotate(0deg)",
          opacity: 0.5,
        }}
      />
    </span>
  );
}

const DiffPanelFileRow = memo(function DiffPanelFileRow(props: {
  fileDiff: FileDiffMetadata;
  resolvedTheme: "light" | "dark";
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  workspaceRoot: string | null;
  isCollapsed: boolean;
  onToggleFileCollapsed: (fileKey: string) => void;
  chatActions?: DiffFileChatActions | undefined;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const fileKey = buildFileDiffRenderKey(props.fileDiff);
  const { chatActions, isCollapsed } = props;
  const shouldPreviewImage =
    !isCollapsed && props.workspaceRoot !== null && isSupportedLocalImagePath(filePath);
  const renderHeaderTrailing = useCallback(
    () => (
      <>
        {chatActions ? (
          <span data-diff-header-menu="true" className="inline-flex">
            <DiffFileHeaderActionsMenu filePath={filePath} chatActions={chatActions} />
          </span>
        ) : null}
        <DiffFileCollapseChevron collapsed={isCollapsed} />
      </>
    ),
    [chatActions, filePath, isCollapsed],
  );
  const handleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const nativeEvent = event.nativeEvent;
      const composedPath = nativeEvent.composedPath?.() ?? [];
      // Clicks on the per-file actions menu must not toggle collapse.
      const clickedHeaderMenu = composedPath.some(
        (node: EventTarget) =>
          node instanceof Element && node.hasAttribute("data-diff-header-menu"),
      );
      if (clickedHeaderMenu) return;
      const clickedHeader = composedPath.some((node: EventTarget) => {
        if (!(node instanceof Element)) return false;
        return (
          node.hasAttribute("data-diff-file-header") ||
          node.hasAttribute("data-diffs-header") ||
          node.hasAttribute("data-file-info")
        );
      });
      if (!clickedHeader) return;
      event.stopPropagation();
      props.onToggleFileCollapsed(fileKey);
    },
    [fileKey, props.onToggleFileCollapsed],
  );

  return (
    <div
      data-diff-file-path={filePath}
      className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
      onClickCapture={handleClickCapture}
    >
      <FileDiffCard
        fileDiff={props.fileDiff}
        theme={props.resolvedTheme}
        diffStyle={props.diffRenderMode === "split" ? "split" : "unified"}
        overflow={props.diffWordWrap ? "wrap" : "scroll"}
        collapsed={props.isCollapsed}
        renderHeaderTrailing={renderHeaderTrailing}
      />
      {shouldPreviewImage ? (
        <LocalImagePreview
          src={filePath}
          cwd={props.workspaceRoot}
          alt={`Preview of ${filePath}`}
          className="diff-render-file__image-preview"
          imageClassName="max-h-[320px]"
        />
      ) : null}
    </div>
  );
});

function areCollapsedSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

export const DiffPanelFileList = memo(
  function DiffPanelFileList(props: {
    renderableFiles: ReadonlyArray<FileDiffMetadata>;
    resolvedTheme: "light" | "dark";
    diffRenderMode: DiffRenderMode;
    diffWordWrap: boolean;
    workspaceRoot: string | null;
    collapsedFiles: ReadonlySet<string>;
    onToggleFileCollapsed: (fileKey: string) => void;
    chatActions?: DiffFileChatActions | undefined;
  }) {
    if (props.renderableFiles.length === 0) {
      return (
        <FileDiffSurface className="h-full min-h-0 overflow-auto px-2 pb-2">
          <PanelStateMessage density="compact" fill="flex">
            <p>No files in this diff.</p>
          </PanelStateMessage>
        </FileDiffSurface>
      );
    }

    return (
      <FileDiffSurface className="h-full min-h-0 overflow-auto px-2 pb-2">
        {props.renderableFiles.map((fileDiff) => {
          const fileKey = buildFileDiffRenderKey(fileDiff);
          const themedFileKey = `${fileKey}:${props.resolvedTheme}`;
          return (
            <DiffPanelFileRow
              key={themedFileKey}
              fileDiff={fileDiff}
              resolvedTheme={props.resolvedTheme}
              diffRenderMode={props.diffRenderMode}
              diffWordWrap={props.diffWordWrap}
              workspaceRoot={props.workspaceRoot}
              isCollapsed={props.collapsedFiles.has(fileKey)}
              onToggleFileCollapsed={props.onToggleFileCollapsed}
              chatActions={props.chatActions}
            />
          );
        })}
      </FileDiffSurface>
    );
  },
  (previous, next) => {
    return (
      previous.renderableFiles === next.renderableFiles &&
      previous.resolvedTheme === next.resolvedTheme &&
      previous.diffRenderMode === next.diffRenderMode &&
      previous.diffWordWrap === next.diffWordWrap &&
      previous.workspaceRoot === next.workspaceRoot &&
      areCollapsedSetsEqual(previous.collapsedFiles, next.collapsedFiles) &&
      previous.onToggleFileCollapsed === next.onToggleFileCollapsed &&
      previous.chatActions === next.chatActions
    );
  },
);
