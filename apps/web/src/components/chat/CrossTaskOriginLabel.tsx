// FILE: CrossTaskOriginLabel.tsx
// Purpose: Identify the source task for conversations created by another Synara agent.
// Layer: Chat transcript UI

import { PROVIDER_DISPLAY_NAMES, type ProviderKind, type ThreadId } from "@synara/contracts";
import { memo, type ReactNode } from "react";

import { ProviderIcon } from "../ProviderIcon";
import { SynaraLogo } from "../SynaraLogo";
import { cn } from "~/lib/utils";

export interface CrossTaskOrigin {
  readonly sourceThreadId: ThreadId;
  readonly sourceProvider: ProviderKind | null;
}

function OriginContent({ origin }: { readonly origin: CrossTaskOrigin }): ReactNode {
  const providerLabel = origin.sourceProvider
    ? PROVIDER_DISPLAY_NAMES[origin.sourceProvider]
    : null;

  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
        {origin.sourceProvider ? (
          <ProviderIcon provider={origin.sourceProvider} className="size-4" />
        ) : (
          <SynaraLogo className="h-4 w-auto" aria-label="Synara" />
        )}
      </span>
      <span className="truncate">
        {providerLabel ? `Sent by ${providerLabel} from another task` : "Sent from another task"}
      </span>
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
    "inline-flex max-w-full items-center gap-2 self-start rounded-md py-1",
    "font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72",
    onOpenSourceThread &&
      "cursor-pointer transition-colors duration-150 hover:text-foreground/82 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  );

  if (onOpenSourceThread) {
    return (
      <button
        type="button"
        className={className}
        data-cross-task-origin="true"
        aria-label="Open source task"
        onClick={() => onOpenSourceThread(origin.sourceThreadId)}
      >
        <OriginContent origin={origin} />
      </button>
    );
  }

  return (
    <div className={className} data-cross-task-origin="true">
      <OriginContent origin={origin} />
    </div>
  );
});
