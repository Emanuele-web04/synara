import { cn } from "~/lib/utils";
import { PR_QUIET_INK_CLASS_NAME } from "./pullRequestText";

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function PullRequestDiffStat({
  additions,
  deletions,
  tone: toneProp,
  className,
}: {
  additions: number;
  deletions: number;
  tone?: "muted" | "diff";
  className?: string;
}) {
  const tone = toneProp ?? "muted";
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1 tabular-nums",
        tone === "muted" && PR_QUIET_INK_CLASS_NAME,
        className,
      )}
    >
      <span className={tone === "diff" ? "text-[var(--color-decoration-added)]" : undefined}>
        +{formatCount(additions)}
      </span>
      <span className={tone === "diff" ? "text-[var(--color-decoration-deleted)]" : undefined}>
        -{formatCount(deletions)}
      </span>
    </span>
  );
}
