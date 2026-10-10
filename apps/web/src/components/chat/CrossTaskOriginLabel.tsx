import { type ProviderKind, type ThreadId } from "@synara/contracts";
import { memo, type ReactNode } from "react";

import { SynaraLogo } from "../SynaraLogo";
import { cn } from "~/lib/utils";

export interface CrossTaskOrigin {
  readonly sourceThreadId: ThreadId;
  readonly sourceProvider: ProviderKind | null;
  /** Set when the source is a group coordinator, so the label names the group. */
  readonly coordinatorGroupName?: string | null | undefined;
}

// A single, app-level attribution: the message reached this thread from another
// Synara thread, so it reads as "Sent by Synara" with the Synara mark (the origin
// provider is not surfaced here to keep one consistent label). A group
// coordinator's brief names the group instead, so a worker thread says who
// handed it the task and where the result goes back to.
function crossTaskOriginText(origin: CrossTaskOrigin): string {
  const groupName = origin.coordinatorGroupName?.trim();
  return groupName ? `Sent by the ${groupName} coordinator` : "Sent by Synara from another thread";
}

function OriginContent({ text }: { readonly text: string }): ReactNode {
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
        <SynaraLogo className="h-4 w-auto" aria-label="Synara" />
      </span>
      <span className="truncate">{text}</span>
    </>
  );
}

export const CrossTaskOriginLabel = memo(function CrossTaskOriginLabel({
  origin,
  onOpenSourceThread,
}: {
  readonly origin: CrossTaskOrigin;
  readonly onOpenSourceThread?: (threadId: ThreadId) => void;
}) {
  const className = cn(
    "inline-flex max-w-full items-center gap-2 self-end rounded-md py-1",
    "font-system-ui text-ui font-normal text-muted-foreground/72",
    onOpenSourceThread &&
      "cursor-pointer transition-colors duration-150 hover:text-foreground/82 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  );

  if (onOpenSourceThread) {
    return (
      <button
        type="button"
        className={className}
        data-cross-task-origin="true"
        aria-label={origin.coordinatorGroupName ? "Open coordinator" : "Open source thread"}
        onClick={() => onOpenSourceThread(origin.sourceThreadId)}
      >
        <OriginContent text={crossTaskOriginText(origin)} />
      </button>
    );
  }

  return (
    <div className={className} data-cross-task-origin="true">
      <OriginContent text={crossTaskOriginText(origin)} />
    </div>
  );
});
