import type { HubWorkItem, ThreadId } from "@synara/contracts";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { IconButton } from "~/components/ui/icon-button";
import { Button } from "~/components/ui/button";
import { useState } from "react";
import { TaskProgressSteps } from "../TaskProgressSteps";

const STATE_LABELS: Record<HubWorkItem["state"], string> = {
  queued: "Queued",
  starting: "Starting",
  working: "Working",
  waiting: "Waiting on you",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function HubWorkItemCard({
  item,
  onOpenThread,
}: {
  item: HubWorkItem;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(true);
  const workerThreadId = item.workerThreadId;
  const hasDetails = Boolean(
    item.progress?.steps.length || item.progress?.summary || item.resultSummary,
  );
  return (
    <article
      className="rounded-xl border border-border/70 bg-card/50 px-3 py-2"
      aria-label={`Work: ${item.title}`}
    >
      <div className="flex items-center gap-2">
        {hasDetails ? (
          <IconButton
            className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
            onClick={() => setExpanded(!expanded)}
            label={`${expanded ? "Hide" : "Show"} progress for ${item.title}`}
            aria-expanded={expanded}
          >
            <DisclosureChevron open={expanded} className="size-3" />
          </IconButton>
        ) : null}
        {workerThreadId && onOpenThread ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto min-w-0 flex-1 justify-start truncate p-0 text-left text-ui font-medium hover:bg-transparent hover:underline"
            onClick={() => onOpenThread(workerThreadId)}
          >
            {item.title}
          </Button>
        ) : (
          <p className="min-w-0 flex-1 truncate text-ui font-medium">{item.title}</p>
        )}
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {STATE_LABELS[item.state]}
        </span>
      </div>
      {item.state === "queued" && item.queueReason ? (
        <p className="mt-1 text-ui-sm text-muted-foreground">{item.queueReason}</p>
      ) : null}
      <DisclosureRegion open={hasDetails && expanded}>
        {item.progress?.summary ? (
          <p className="mt-2 text-ui-sm text-muted-foreground">{item.progress.summary}</p>
        ) : null}
        {item.progress?.steps.length ? (
          <TaskProgressSteps steps={item.progress.steps} className="mt-1" />
        ) : null}
        {item.resultSummary ? (
          <p className="mt-2 whitespace-pre-wrap text-ui">{item.resultSummary}</p>
        ) : null}
      </DisclosureRegion>
    </article>
  );
}

export function HubWorkItemCards({
  items,
  onOpenThread,
}: {
  items: readonly HubWorkItem[];
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <HubWorkItemCard key={item.id} item={item} onOpenThread={onOpenThread} />
      ))}
    </div>
  );
}
