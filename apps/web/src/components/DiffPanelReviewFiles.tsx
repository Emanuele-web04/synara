// FILE: DiffPanelReviewFiles.tsx
// Purpose: Render the diff panel's "files" review surface — one collapsible
//   FileDiffCard per changed file, with header-click collapse toggling.
// Layer: web (presentational component for DiffPanel).
// Exports: DiffPanelReviewFiles (default)
import type { FileDiffMetadata } from "@pierre/diffs/react";

import { ChevronDownIcon } from "~/lib/icons";
import { buildFileDiffRenderKey, resolveFileDiffPath } from "../lib/diffRendering";
import { FileDiffCard, FileDiffSurface } from "./chat/FileDiffView";

interface DiffPanelReviewFilesProps {
  files: FileDiffMetadata[];
  theme: "light" | "dark";
  diffStyle: "unified" | "split";
  overflow: "scroll" | "wrap";
  collapsedFiles: Set<string>;
  onToggleFileCollapsed: (fileKey: string) => void;
}

export default function DiffPanelReviewFiles({
  files,
  theme,
  diffStyle,
  overflow,
  collapsedFiles,
  onToggleFileCollapsed,
}: DiffPanelReviewFilesProps) {
  return (
    <FileDiffSurface className="h-full min-h-0 overflow-auto px-2 pb-2">
      {files.map((fileDiff) => {
        const filePath = resolveFileDiffPath(fileDiff);
        const fileKey = buildFileDiffRenderKey(fileDiff);
        const themedFileKey = `${fileKey}:${theme}`;
        const isCollapsed = collapsedFiles.has(fileKey);
        return (
          <div
            key={themedFileKey}
            data-diff-file-path={filePath}
            className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
            onClickCapture={(event) => {
              const nativeEvent = event.nativeEvent as MouseEvent;
              const composedPath = nativeEvent.composedPath?.() ?? [];
              const clickedHeader = composedPath.some((node) => {
                if (!(node instanceof Element)) return false;
                return (
                  node.hasAttribute("data-diffs-header") || node.hasAttribute("data-file-info")
                );
              });
              if (!clickedHeader) return;
              event.stopPropagation();
              onToggleFileCollapsed(fileKey);
            }}
          >
            <FileDiffCard
              fileDiff={fileDiff}
              theme={theme}
              diffStyle={diffStyle}
              overflow={overflow}
              collapsed={isCollapsed}
              renderHeaderMetadata={() => (
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
                      transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                      opacity: 0.5,
                    }}
                  />
                </span>
              )}
            />
          </div>
        );
      })}
    </FileDiffSurface>
  );
}
