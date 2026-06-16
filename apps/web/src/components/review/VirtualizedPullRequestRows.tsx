import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode, UIEvent } from "react";
import { useEffect, useRef } from "react";

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
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems.at(-1);
  const paddingTop = firstVirtualItem?.start ?? 0;
  const paddingBottom =
    lastVirtualItem === undefined
      ? 0
      : Math.max(virtualizer.getTotalSize() - lastVirtualItem.end, 0);

  return (
    <ul
      ref={scrollRef}
      role="list"
      className={cn("overflow-y-auto", props.className)}
      onScroll={handleScroll}
    >
      {paddingTop > 0 ? <li aria-hidden="true" style={{ height: paddingTop }} /> : null}
      {virtualItems.map((virtualItem) => {
        const pullRequest = props.pullRequests[virtualItem.index];
        if (!pullRequest) {
          return null;
        }
        return (
          <li
            key={pullRequest.number}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            role="listitem"
            className={props.rowClassName}
          >
            {props.renderPullRequest(pullRequest)}
          </li>
        );
      })}
      {paddingBottom > 0 ? <li aria-hidden="true" style={{ height: paddingBottom }} /> : null}
    </ul>
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
