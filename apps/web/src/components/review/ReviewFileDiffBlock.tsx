import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import type { ReactNode } from "react";
import { memo, useCallback, useMemo } from "react";

import {
  buildDiffPanelUnsafeCSS,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { CheckIcon, ChevronDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { FileEntryIcon } from "../chat/FileEntryIcon";
import { fromAnnotationSide, type ReviewLineAnnotationData } from "./reviewAnnotations";

export interface ReviewDraftAnchor {
  path: string;
  line: number;
  side: ReviewLineAnnotationData["side"];
}

export interface ReviewFileDiffBlockProps {
  fileDiff: FileDiffMetadata;
  theme: "light" | "dark";
  diffStyle?: "unified" | "split";
  overflow?: "scroll" | "wrap";
  collapsed?: boolean;
  reviewed?: boolean;
  lineAnnotations: ReadonlyArray<DiffLineAnnotation<ReviewLineAnnotationData>>;
  onToggleReviewed?: () => void;
  onStartDraft: (anchor: ReviewDraftAnchor) => void;
  renderAnnotation: (data: ReviewLineAnnotationData) => ReactNode;
}

// Render @pierre/diffs FileDiff directly (not via FileDiffCard) so the review
// surface can attach inline annotations and a gutter "+" to start drafts.
// Theme/CSS/diffStyle/overflow/header mirror FileDiffView's FileDiffCard.
export const ReviewFileDiffBlock = memo(function ReviewFileDiffBlockView(
  props: ReviewFileDiffBlockProps,
) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const { onStartDraft } = props;
  const lineAnnotations = useMemo(() => [...props.lineAnnotations], [props.lineAnnotations]);

  const handleGutterUtilityClick = useCallback(
    (range: SelectedLineRange) => {
      const side = fromAnnotationSide(range.side ?? "additions");
      onStartDraft({ path: filePath, line: range.start, side });
    },
    [filePath, onStartDraft],
  );

  return (
    <FileDiff<ReviewLineAnnotationData>
      fileDiff={props.fileDiff}
      lineAnnotations={lineAnnotations}
      renderAnnotation={(annotation) =>
        annotation.metadata ? props.renderAnnotation(annotation.metadata) : null
      }
      options={{
        diffStyle: props.diffStyle ?? "unified",
        lineDiffType: "none",
        overflow: props.overflow ?? "scroll",
        theme: resolveDiffThemeName(props.theme),
        themeType: props.theme,
        unsafeCSS: buildDiffPanelUnsafeCSS(props.theme),
        enableGutterUtility: true,
        onGutterUtilityClick: handleGutterUtilityClick,
        ...(props.collapsed !== undefined ? { collapsed: props.collapsed } : {}),
      }}
      renderHeaderPrefix={() => (
        <FileEntryIcon pathValue={filePath} kind="file" theme={props.theme} className="size-4" />
      )}
      renderHeaderMetadata={() => (
        <span className="inline-flex items-center gap-2 text-inherit">
          {props.onToggleReviewed ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={Boolean(props.reviewed)}
              aria-label={
                props.reviewed ? `Mark ${filePath} as not reviewed` : `Mark ${filePath} as reviewed`
              }
              title={props.reviewed ? "Reviewed" : "Mark as reviewed"}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleReviewed?.();
              }}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] font-medium outline-none",
                "transition-[background-color,border-color,color,opacity] duration-150 motion-reduce:transition-none",
                "focus-visible:ring-2 focus-visible:ring-ring",
                props.reviewed
                  ? "border-success/25 bg-success/12 text-success-foreground"
                  : "border-border/50 bg-muted/20 text-muted-foreground hover:bg-muted/35 hover:text-foreground",
              )}
            >
              <CheckIcon className={cn("size-3", !props.reviewed && "opacity-45")} />
              {props.reviewed ? "Reviewed" : "Mark reviewed"}
            </button>
          ) : null}
          <ChevronDownIcon
            style={{
              width: "14px",
              height: "14px",
              transition: "transform 150ms ease",
              transform: props.collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            }}
          />
        </span>
      )}
    />
  );
}, areReviewFileDiffBlockPropsEqual);

function areReviewFileDiffBlockPropsEqual(
  previous: ReviewFileDiffBlockProps,
  next: ReviewFileDiffBlockProps,
): boolean {
  return (
    previous.fileDiff === next.fileDiff &&
    previous.theme === next.theme &&
    previous.diffStyle === next.diffStyle &&
    previous.overflow === next.overflow &&
    previous.collapsed === next.collapsed &&
    previous.reviewed === next.reviewed &&
    previous.lineAnnotations === next.lineAnnotations &&
    previous.onToggleReviewed === next.onToggleReviewed &&
    previous.onStartDraft === next.onStartDraft &&
    previous.renderAnnotation === next.renderAnnotation
  );
}
