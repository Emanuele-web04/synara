import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import type { ReactNode, UIEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const threshold = props.threshold ?? 0;
  const shouldVirtualize = props.pullRequests.length > threshold;
  const [scrollWindow, setScrollWindow] = useState({
    scrollTop: 0,
    viewportHeight: props.estimateSize * 6,
  });
  const handleScroll = (event: UIEvent<HTMLDivElement | HTMLUListElement>) => {
    const element = event.currentTarget;
    if (shouldVirtualize) {
      setScrollWindow({
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight || props.estimateSize * 6,
      });
    }
    if (!props.onEndReached) {
      return;
    }
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceToBottom <= props.estimateSize * 3) {
      props.onEndReached();
    }
  };

  if (!shouldVirtualize) {
    return (
      <ul className={cn("overflow-y-auto", props.className)} onScroll={handleScroll}>
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
      ref={scrollRef}
      role="list"
      className={cn("overflow-y-auto", props.className)}
      onScroll={handleScroll}
    >
      <div className="relative w-full" style={{ height: totalHeight }}>
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

export function EndReachedSentinel(props: {
  disabled: boolean;
  onEndReached: () => void;
  className?: string;
  label?: string;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || props.disabled) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          props.onEndReached();
        }
      },
      { root: null, rootMargin: "320px 0px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [props.disabled, props.onEndReached]);

  return (
    <div
      ref={sentinelRef}
      className={cn("flex h-8 shrink-0 items-center justify-center", props.className)}
      aria-hidden={props.disabled ? true : undefined}
    >
      {!props.disabled && props.label ? (
        <span className="text-[11px] text-muted-foreground">{props.label}</span>
      ) : null}
    </div>
  );
}
