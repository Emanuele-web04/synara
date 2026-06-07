// FILE: DiffPanelFileList.tsx
// Purpose: Memoized multi-file diff list for the review panel — isolates @pierre/diffs
//          rendering from chat-stream re-renders in the parent DiffPanel shell.
// Layer: Diff panel UI

import type { FileDiffMetadata } from "@pierre/diffs/react";
import { memo, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDownIcon } from "~/lib/icons";

import { buildFileDiffRenderKey, resolveFileDiffPath } from "~/lib/diffRendering";
import { FileDiffCard, FileDiffSurface } from "./chat/FileDiffView";
import { PanelStateMessage } from "./chat/PanelStateMessage";

type DiffRenderMode = "stacked" | "split";

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
  isCollapsed: boolean;
  onToggleFileCollapsed: (fileKey: string) => void;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const fileKey = buildFileDiffRenderKey(props.fileDiff);
  const renderHeaderMetadata = useCallback(
    () => <DiffFileCollapseChevron collapsed={props.isCollapsed} />,
    [props.isCollapsed],
  );
  const handleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const nativeEvent = event.nativeEvent;
      const composedPath = nativeEvent.composedPath?.() ?? [];
      const clickedHeader = composedPath.some((node: EventTarget) => {
        if (!(node instanceof Element)) return false;
        return node.hasAttribute("data-diffs-header") || node.hasAttribute("data-file-info");
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
        renderHeaderMetadata={renderHeaderMetadata}
      />
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
    collapsedFiles: ReadonlySet<string>;
    onToggleFileCollapsed: (fileKey: string) => void;
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
              isCollapsed={props.collapsedFiles.has(fileKey)}
              onToggleFileCollapsed={props.onToggleFileCollapsed}
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
      areCollapsedSetsEqual(previous.collapsedFiles, next.collapsedFiles) &&
      previous.onToggleFileCollapsed === next.onToggleFileCollapsed
    );
  },
);
