import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

const SCROLL_VIEWPORT_CLASS = "overflow-y-auto overscroll-contain [scrollbar-gutter:stable]";

export function VirtualizedPullRequestRows(props: {
  pullRequests: ReadonlyArray<ReviewPullRequestSummary>;
  renderPullRequest: (pullRequest: ReviewPullRequestSummary) => ReactNode;
  estimateSize: number;
  className?: string;
  rowClassName?: string;
  overscan?: number;
  threshold?: number;
  onEndReached?: () => void;
}) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const appliedRef = useRef({ startIndex: -1, viewportHeight: 0 });
  const threshold = props.threshold ?? 0;
  const shouldVirtualize = props.pullRequests.length > threshold;
  const [scrollWindow, setScrollWindow] = useState({
    scrollTop: 0,
    viewportHeight: props.estimateSize * 6,
  });

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  const syncScroll = () => {
    frameRef.current = null;
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const scrollTop = element.scrollTop;
    const viewportHeight = element.clientHeight || props.estimateSize * 6;
    if (shouldVirtualize) {
      const startIndex = Math.floor(scrollTop / props.estimateSize);
      const applied = appliedRef.current;
      if (startIndex !== applied.startIndex || viewportHeight !== applied.viewportHeight) {
        appliedRef.current = { startIndex, viewportHeight };
        setScrollWindow({ scrollTop, viewportHeight });
      }
    }
    if (props.onEndReached) {
      const distanceToBottom = element.scrollHeight - scrollTop - element.clientHeight;
      if (distanceToBottom <= props.estimateSize * 3) {
        props.onEndReached();
      }
    }
  };

  const handleScroll = () => {
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = requestAnimationFrame(syncScroll);
  };

  if (!shouldVirtualize) {
    return (
      <ul
        ref={(node) => {
          scrollRef.current = node;
        }}
        className={cn(SCROLL_VIEWPORT_CLASS, props.className)}
        onScroll={handleScroll}
      >
        {props.pullRequests.map((pullRequest) => (
          <li key={pullRequest.number} className={props.rowClassName}>
            {props.renderPullRequest(pullRequest)}
          </li>
        ))}
      </ul>
    );
  }

  const overscan = props.overscan ?? 10;
  const rowCount = props.pullRequests.length;
  const visibleStartIndex = Math.floor(scrollWindow.scrollTop / props.estimateSize);
  const visibleRowCount = Math.ceil(scrollWindow.viewportHeight / props.estimateSize);
  const startIndex = Math.max(visibleStartIndex - overscan, 0);
  const endIndex = Math.min(visibleStartIndex + visibleRowCount + overscan, rowCount);
  const virtualPullRequests = props.pullRequests.slice(startIndex, endIndex);
  const totalHeight = rowCount * props.estimateSize;

  return (
    <div
      ref={(node) => {
        scrollRef.current = node;
      }}
      role="list"
      className={cn(SCROLL_VIEWPORT_CLASS, props.className)}
      onScroll={handleScroll}
    >
      <div className="relative w-full [contain:layout_paint]" style={{ height: totalHeight }}>
        {virtualPullRequests.map((pullRequest, offset) => {
          const index = startIndex + offset;
          return (
            <div
              key={pullRequest.number}
              data-index={index}
              role="listitem"
              className={cn("absolute inset-x-0 top-0", props.rowClassName)}
              style={{
                height: props.estimateSize,
                transform: `translateY(${String(index * props.estimateSize)}px)`,
              }}
            >
              {props.renderPullRequest(pullRequest)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
