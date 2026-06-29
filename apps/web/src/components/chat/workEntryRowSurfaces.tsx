// FILE: workEntryRowSurfaces.tsx
// Purpose: Shared interactive shells for transcript work rows.
// Layer: Web chat presentation component
// Exports: OpenableWorkRowSurface, ToolDetailsDisclosure

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { type WorkLogEntry } from "~/session-logic";
import { cn } from "~/lib/utils";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { ToolCallDetailsContent } from "./ToolCallDetailsDialog";

const TRANSCRIPT_DISCLOSURE_TRANSITION_MS = 220;
const TRANSCRIPT_DISCLOSURE_CLEANUP_BUFFER_MS = 40;

export function OpenableWorkRowSurface(props: {
  canOpen: boolean;
  children: ReactNode;
  className: string;
  onHover?: (() => void) | undefined;
  onOpen?: (() => void) | undefined;
  title?: string | undefined;
}) {
  const className = cn(
    props.className,
    props.canOpen ? "cursor-pointer focus-visible:outline-none" : "cursor-default",
  );

  if (props.canOpen) {
    return (
      <button
        type="button"
        className={className}
        title={props.title}
        onClick={props.onOpen}
        {...(props.onHover ? { onPointerEnter: props.onHover, onFocus: props.onHover } : {})}
      >
        {props.children}
      </button>
    );
  }

  return (
    <div className={className} title={props.title}>
      {props.children}
    </div>
  );
}

export function ToolDetailsDisclosure(props: {
  children: ReactNode;
  compact: boolean;
  dataFileChangeRow?: boolean | undefined;
  details: NonNullable<WorkLogEntry["toolDetails"]>;
  summaryClassName?: string | undefined;
  title?: string | undefined;
}) {
  const summaryClassName =
    props.summaryClassName ??
    cn(
      "group/tool-row flex w-full items-center text-left transition-[opacity,translate] duration-200",
      props.compact ? "gap-1.5" : "gap-2",
      "cursor-pointer focus-visible:outline-none",
    );
  const [open, setOpen] = useState(false);
  const [renderDetails, setRenderDetails] = useState(false);
  const [motionOpen, setMotionOpen] = useState(false);
  const detailsRegionId = useId();
  const openFrameRef = useRef<number | null>(null);
  const cleanupTimeoutRef = useRef<number | null>(null);

  const clearMotionTimers = useCallback(() => {
    if (openFrameRef.current !== null) {
      window.cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = null;
    }
    if (cleanupTimeoutRef.current !== null) {
      window.clearTimeout(cleanupTimeoutRef.current);
      cleanupTimeoutRef.current = null;
    }
  }, []);

  const setDetailsOpen = useCallback(
    (nextOpen: boolean) => {
      clearMotionTimers();
      setOpen(nextOpen);

      if (nextOpen) {
        setRenderDetails(true);
        setMotionOpen(false);
        openFrameRef.current = window.requestAnimationFrame(() => {
          openFrameRef.current = null;
          setMotionOpen(true);
        });
        return;
      }

      setMotionOpen(false);
      cleanupTimeoutRef.current = window.setTimeout(() => {
        cleanupTimeoutRef.current = null;
        setRenderDetails(false);
      }, TRANSCRIPT_DISCLOSURE_TRANSITION_MS + TRANSCRIPT_DISCLOSURE_CLEANUP_BUFFER_MS);
    },
    [clearMotionTimers],
  );

  useEffect(() => () => clearMotionTimers(), [clearMotionTimers]);

  return (
    <div className="group/tool-details min-w-0">
      <button
        type="button"
        className={summaryClassName}
        title={props.title ?? "View tool details"}
        aria-expanded={open}
        aria-controls={detailsRegionId}
        data-file-change-row={props.dataFileChangeRow ? "true" : undefined}
        data-tool-detail-trigger="true"
        onClick={() => {
          setDetailsOpen(!open);
        }}
      >
        {props.children}
        <DisclosureChevron
          open={open}
          className="text-muted-foreground/38 group-hover/tool-row:text-foreground group-hover/file-row:text-foreground group-focus-visible/tool-row:text-foreground group-focus-visible/file-row:text-foreground"
        />
      </button>
      {renderDetails ? (
        <DisclosureRegion
          open={motionOpen}
          contentClassName={cn("min-w-0 pt-2", props.compact ? "ml-5" : "ml-7")}
        >
          <div
            id={detailsRegionId}
            role="region"
            aria-label="Tool details"
            data-tool-details-inline="true"
          >
            <ToolCallDetailsContent details={props.details} />
          </div>
        </DisclosureRegion>
      ) : null}
    </div>
  );
}
