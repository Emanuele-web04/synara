import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode, UIEvent } from "react";
import { useRef } from "react";

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
  const handleScroll = (event: UIEvent<HTMLDivElement | HTMLUListElement>) => {
    if (!props.onEndReached) {
      return;
    }
    const element = event.currentTarget;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceToBottom <= props.estimateSize * 3) {
      props.onEndReached();
    }
  };
  const virtualizer = useVirtualizer({
    count: props.pullRequests.length,
    estimateSize: () => props.estimateSize,
    getScrollElement: () => scrollRef.current,
    overscan: props.overscan ?? 10,
    enabled: shouldVirtualize,
    initialRect: {
      height: props.estimateSize * 6,
      width: 0,
    },
  });

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

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      role="list"
      className={cn("overflow-y-auto", props.className)}
      onScroll={handleScroll}
    >
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtualItem) => {
          const pullRequest = props.pullRequests[virtualItem.index];
          if (!pullRequest) {
            return null;
          }
          return (
            <div
              key={pullRequest.number}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              role="listitem"
              className={cn("absolute start-0 top-0 w-full", props.rowClassName)}
              style={{ transform: `translateY(${String(virtualItem.start)}px)` }}
            >
              {props.renderPullRequest(pullRequest)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
