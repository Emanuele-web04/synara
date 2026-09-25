import type { FileDiffMetadata } from "@pierre/diffs/react";
import { useEffect, useState, type RefObject } from "react";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { readDiffFileAnchors, resolveDiffRenderSurface } from "~/lib/diffScrollSurface";
import {
  DIFF_CHANGE_MARKER_HEIGHT_PX,
  resolveDiffChangeMarkers,
  type DiffChangeMarker,
  type DiffChangeMarkerKind,
} from "./DiffPanel.logic";

const CHANGE_MARKER_COLOR_BY_KIND: Record<DiffChangeMarkerKind, string> = {
  added: "var(--success)",
  removed: "var(--destructive)",
  modified: "var(--muted-foreground)",
};

const CHANGE_MARKER_LABEL_BY_KIND: Record<DiffChangeMarkerKind, string> = {
  added: "Added",
  removed: "Deleted",
  modified: "Modified",
};

export function DiffPanelChangeMarkers(props: {
  viewportRef: RefObject<HTMLElement | null>;
  renderableFiles: ReadonlyArray<FileDiffMetadata>;
  onSelectFilePath: (filePath: string) => void;
}) {
  const { renderableFiles, viewportRef } = props;
  const [markers, setMarkers] = useState<ReadonlyArray<DiffChangeMarker>>([]);

  useEffect(() => {
    const surface = resolveDiffRenderSurface(viewportRef.current);
    if (!surface || renderableFiles.length === 0) {
      setMarkers([]);
      return;
    }

    const changeTypeByPath = new Map(
      renderableFiles.map((fileDiff) => [resolveFileDiffPath(fileDiff), fileDiff.type] as const),
    );

    let frame = 0;
    const measure = () => {
      frame = 0;
      const anchors = readDiffFileAnchors(surface);
      const surfaceTop = surface.getBoundingClientRect().top - surface.scrollTop;
      const files = anchors.flatMap((anchor) => {
        const changeType = changeTypeByPath.get(anchor.path);
        if (!changeType) {
          return [];
        }
        return [
          {
            path: anchor.path,
            offsetTop: anchor.element.getBoundingClientRect().top - surfaceTop,
            changeType,
          },
        ];
      });
      setMarkers(
        resolveDiffChangeMarkers({
          files,
          scrollHeight: surface.scrollHeight,
          stripHeight: surface.clientHeight,
        }),
      );
    };
    const schedule = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(measure);
    };

    schedule();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(surface);
    for (const anchor of readDiffFileAnchors(surface)) {
      resizeObserver.observe(anchor.element);
    }

    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      resizeObserver.disconnect();
    };
  }, [renderableFiles, viewportRef]);

  if (markers.length === 0) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label="Change markers"
      className="pointer-events-none absolute inset-y-0 right-[10px] z-10 w-[6px]"
    >
      {markers.map((marker) => (
        // 24px hit box centered on the 3px bar; the box may overflow the strip
        // edge but only empty padding is clipped, so the bar stays aligned.
        <button
          key={marker.path}
          type="button"
          aria-label={`${CHANGE_MARKER_LABEL_BY_KIND[marker.kind]}: ${marker.path}`}
          title={marker.path}
          className="group pointer-events-auto absolute right-0 flex h-6 w-6 cursor-pointer items-center justify-end rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
          style={{
            top: `${marker.top + DIFF_CHANGE_MARKER_HEIGHT_PX / 2 - 12}px`,
          }}
          onClick={() => {
            props.onSelectFilePath(marker.path);
          }}
        >
          <span
            aria-hidden="true"
            className="h-[3px] w-1.5 rounded-full opacity-70 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            style={{ backgroundColor: CHANGE_MARKER_COLOR_BY_KIND[marker.kind] }}
          />
        </button>
      ))}
    </div>
  );
}
