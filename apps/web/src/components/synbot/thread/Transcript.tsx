// FILE: Transcript.tsx
// Purpose: A bot thread's transcript (HoloBot's thread/Transcript.tsx), following the tail: while
//          it is at its end it stays there as rows come and grow (a reply, the typing row, a
//          card, the composer growing); scrolling up leaves the tail and reading older rows is not
//          interrupted until the reader scrolls back down, sends (a new message of the user's at
//          the end, `followKey`), or jumps to the latest (the round button). Rules in
//          transcriptFollow.ts. It says whether rows run under the
//          top strip or the composer (`onEdges`), so the pane fades and blurs there only. Rows
//          coming in above the reader leave them on the row they were reading.
// Layer: SynBot thread UI
// Exports: Transcript, TranscriptEdges

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useTranslation } from "~/i18n";

import { IconButton } from "../kit/controls";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import {
  afterScroll,
  initialFollow,
  shouldPin,
  showsLatest,
  type FollowState,
  type ScrollMetrics,
} from "./transcriptFollow";

/** The jump's glide to the end. */
const GLIDE_MS = 320;

export interface TranscriptEdges {
  /** Rows run under the top strip. */
  readonly top: boolean;
  /** Rows run under the composer. */
  readonly bottom: boolean;
}

const metricsOf = (el: HTMLElement): ScrollMetrics => ({
  scrollTop: el.scrollTop,
  scrollHeight: el.scrollHeight,
  clientHeight: el.clientHeight,
});

/** Where `row` is in the scrolled content of `el`. */
function offsetIn(el: Element, row: Element): number {
  return row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
}

/** The first row reaching below `top` (rows are in order, so a binary search). */
function rowAt(el: HTMLElement, top: number): Element | null {
  const rows = el.children;
  let low = 0;
  let high = rows.length - 1;
  let found: Element | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const row = rows[mid]!;
    if (offsetIn(el, row) + row.getBoundingClientRect().height > top) {
      found = row;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

export function Transcript({
  opens,
  watch,
  followKey,
  bottomInsetPx,
  onEdges,
  children,
}: {
  /** Another conversation in the same list: it opens at its end. */
  readonly opens: unknown;
  /** What changes the rows (new rows, the typing row): the end stays in view while following. */
  readonly watch: readonly unknown[];
  /** The user's newest message: when another one arrives (a send), the list goes to its end
   * and follows again. Nothing else re-arms a reader who scrolled away. */
  readonly followKey?: string | null;
  /** The floating composer's height: the last row stays clear of it. */
  readonly bottomInsetPx: number;
  readonly onEdges?: (edges: TranscriptEdges) => void;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const follow = useRef<FollowState>(initialFollow);
  // A jump to the latest under way: each frame aims at the end as it is then.
  const jumping = useRef(false);
  const glide = useRef(0);
  const [far, setFar] = useState(false);
  const farRef = useRef(false);
  const edges = useRef<TranscriptEdges>({ top: false, bottom: false });
  const onEdgesRef = useRef(onEdges);
  useEffect(() => {
    onEdgesRef.current = onEdges;
  });
  // The row at the top of the view and where it was: rows coming in above it move the list by
  // as much, so the reader stays on it.
  const anchor = useRef<{ row: Element; top: number } | null>(null);

  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    const row = rowAt(el, el.scrollTop);
    anchor.current = row ? { row, top: offsetIn(el, row) } : null;
    const metrics = metricsOf(el);
    const nextFar = showsLatest(follow.current, metrics, farRef.current);
    if (nextFar !== farRef.current) {
      farRef.current = nextFar;
      setFar(nextFar);
    }
    const next = {
      top: el.scrollTop > 0,
      bottom: metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight > 1,
    };
    if (next.top !== edges.current.top || next.bottom !== edges.current.bottom) {
      edges.current = next;
      onEdgesRef.current?.(next);
    }
  };
  const stopGlide = () => {
    jumping.current = false;
    cancelAnimationFrame(glide.current);
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const before = follow.current.following;
    follow.current = afterScroll(follow.current, metricsOf(el));
    if (before && !follow.current.following) stopGlide();
    measure();
  };
  /** Keeps the end in view while following (a jump's glide follows it on its own). */
  const pin = () => {
    const el = scroller.current;
    if (!el) return;
    if (!jumping.current) {
      if (shouldPin(follow.current, metricsOf(el))) {
        el.scrollTop = el.scrollHeight;
        follow.current = { following: true, lastTop: el.scrollTop };
      } else if (follow.current.following) {
        // The reader scrolled up before the scroll event arrived: they are leaving the tail.
        onScroll();
        return;
      }
    }
    measure();
  };
  /** To the very end, gliding; from far up, most of the way at once. */
  const toEnd = () => {
    const el = scroller.current;
    if (!el) return;
    stopGlide();
    const max = el.scrollHeight - el.clientHeight;
    follow.current = { following: true, lastTop: el.scrollTop };
    if (reduced || max - el.scrollTop <= 1) {
      el.scrollTop = el.scrollHeight;
      follow.current = { following: true, lastTop: el.scrollTop };
      measure();
      return;
    }
    const from = Math.max(el.scrollTop, max - el.clientHeight * 1.5);
    const start = performance.now();
    const step = (now: number) => {
      if (!jumping.current) return;
      const progress = Math.min(1, Math.max(0, (now - start) / GLIDE_MS));
      const target = el.scrollHeight - el.clientHeight;
      el.scrollTop = from + (target - from) * (1 - (1 - progress) ** 3);
      follow.current = { following: true, lastTop: el.scrollTop };
      if (progress < 1) glide.current = requestAnimationFrame(step);
      else jumping.current = false;
    };
    jumping.current = true;
    glide.current = requestAnimationFrame(step);
    measure();
  };

  useEffect(() => stopGlide, []);
  // Another conversation opens at its end.
  useLayoutEffect(() => {
    stopGlide();
    follow.current = initialFollow;
  }, [opens]);
  // New rows, and anything that changes size afterwards (a row laid out again, the composer
  // growing above the list's end): the end stays in view while following; a detached reader
  // keeps the row they were reading.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const was = anchor.current;
    if (was && !follow.current.following && was.row.isConnected) {
      const moved = offsetIn(el, was.row) - was.top;
      if (moved !== 0) {
        el.scrollTop += moved;
        follow.current = { following: false, lastTop: el.scrollTop };
      }
    }
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
    // `watch` stands for the rows; the handlers read refs.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, watch);
  // The user sent: to the end, following again (not on the first rows of a thread).
  const sentKey = useRef(followKey ?? null);
  useLayoutEffect(() => {
    const next = followKey ?? null;
    if (next === sentKey.current) return;
    const had = sentKey.current !== null;
    sentKey.current = next;
    if (had && next !== null) toEnd();
    // `toEnd` reads refs only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey]);

  return (
    <div className="thread-frame" style={{ ["--thread-bottom" as string]: `${bottomInsetPx}px` }}>
      <div className="thread" ref={scroller} onScroll={onScroll}>
        {children}
      </div>
      {far ? (
        <IconButton
          className="thread__latest"
          icon="arrow-down"
          label={t("synbot:latest")}
          onClick={toEnd}
        />
      ) : null}
    </div>
  );
}
