// FILE: PullRequestChecksRing.tsx
// Purpose: Segmented stroke-circle summarizing a PR's check outcomes at a glance — arc length
//          proportional to each bucket (green passed, red failed/cancelled, amber running,
//          muted skipped/neutral), with small gaps between segments like the reference
//          design's checks donut. Replaces a static glyph in the Checks meta row.
// Layer: Pull request presentation
// Exports: PullRequestChecksRing

import type { PullRequestCheck, PullRequestCheckStatus } from "@synara/contracts";

import { cn } from "~/lib/utils";

type RingBucket = "success" | "failure" | "pending" | "neutral";

const BUCKET_ORDER: readonly RingBucket[] = ["success", "failure", "pending", "neutral"];

// Shared with the per-check glyphs: `--status-*` is the role color in light and a lighter tint
// of it in dark, so the ring and the rows below it stay the same green and red.
const BUCKET_COLOR_CLASS: Record<RingBucket, string> = {
  success: "text-status-success",
  failure: "text-status-failure",
  pending: "text-warning",
  neutral: "text-muted-foreground/50",
};

function bucketOf(status: PullRequestCheckStatus): RingBucket {
  switch (status) {
    case "success":
      return "success";
    case "failure":
    case "cancelled":
      return "failure";
    case "pending":
      return "pending";
    default:
      return "neutral";
  }
}

const VIEW_BOX = 16;
const RADIUS = 6.25;
const STROKE_WIDTH = 2.4;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// Gap between segments, in circumference units; only applied when >1 bucket is present.
const SEGMENT_GAP = 2;

export function PullRequestChecksRing({
  checks,
  className,
}: {
  checks: ReadonlyArray<PullRequestCheck>;
  className?: string;
}) {
  const counts = new Map<RingBucket, number>();
  for (const check of checks) {
    const bucket = bucketOf(check.status);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const buckets = BUCKET_ORDER.filter((bucket) => (counts.get(bucket) ?? 0) > 0);
  const total = checks.length;
  const gap = buckets.length > 1 ? SEGMENT_GAP : 0;

  let offset = 0;
  const segments = buckets.map((bucket) => {
    const share = ((counts.get(bucket) ?? 0) / total) * CIRCUMFERENCE;
    const segment = {
      bucket,
      length: Math.max(share - gap, 0.5),
      start: offset + gap / 2,
    };
    offset += share;
    return segment;
  });

  return (
    <svg
      viewBox={`0 0 ${VIEW_BOX} ${VIEW_BOX}`}
      // Start segments at 12 o'clock like the reference donut.
      className={cn("size-3.5 shrink-0 -rotate-90", className)}
      aria-hidden="true"
    >
      {total === 0 ? (
        <circle
          cx={VIEW_BOX / 2}
          cy={VIEW_BOX / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          className="stroke-current text-muted-foreground/40"
        />
      ) : (
        segments.map((segment) => (
          <circle
            key={segment.bucket}
            cx={VIEW_BOX / 2}
            cy={VIEW_BOX / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            strokeDasharray={`${segment.length} ${CIRCUMFERENCE - segment.length}`}
            strokeDashoffset={-segment.start}
            className={cn("stroke-current", BUCKET_COLOR_CLASS[segment.bucket])}
          />
        ))
      )}
    </svg>
  );
}
