// FILE: ProviderHandoffDivider.tsx
// Purpose: Mark where a thread was handed off to another provider/model, in place.
// Layer: Chat transcript UI
// Why: A handoff changes who answers from this point on, so it reads as a
//      transcript boundary (like ForkSourceDivider) rather than a work row
//      folded into the previous turn. Clicking it reveals the transferred context.

import { memo, useState } from "react";

import { ArrowRightIcon, CircleAlertIcon, FastModeIcon, HandoffIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { resolveThreadModelSummary } from "~/lib/threadModelSummary";
import type { ProviderHandoffInfo } from "~/workLog";
import { ProviderIcon } from "../ProviderIcon";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { ProviderHandoffDetails } from "./TimelineWorkEntryRow";

// Same reading order as the composer's model trigger and the thread hover card:
// provider glyph, model name, fast-mode bolt, then the effort label.
function HandoffEndpoint(props: {
  readonly selection: ProviderHandoffInfo["sourceModelSelection"];
  readonly className?: string;
}) {
  const summary = resolveThreadModelSummary(props.selection);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", props.className)}>
      <ProviderIcon provider={props.selection.provider} className="size-3.5 shrink-0" />
      <span className="truncate">{summary?.modelLabel ?? props.selection.model}</span>
      {summary?.fastMode ? (
        <FastModeIcon aria-label="Fast mode" className="size-3 shrink-0 opacity-75" />
      ) : null}
      {summary?.statusLabel ? (
        <span className="shrink-0 opacity-70">{summary.statusLabel}</span>
      ) : null}
    </span>
  );
}

export const ProviderHandoffDivider = memo(function ProviderHandoffDivider({
  info,
}: {
  readonly info: ProviderHandoffInfo;
}) {
  const [open, setOpen] = useState(false);
  const failed = info.status === "failed";

  return (
    <div data-provider-handoff-divider="true" className="w-full py-3 font-system-ui">
      <div className="flex w-full items-center gap-4">
        <span aria-hidden className="h-px min-w-0 flex-1 bg-[color:var(--color-border-light)]" />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "inline-flex min-w-0 shrink items-center gap-2 rounded-sm text-ui-sm transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)]/60",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {failed ? (
            <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <HandoffIcon className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="shrink-0">{failed ? "Handoff failed" : "Context handoff"}</span>
          <HandoffEndpoint selection={info.sourceModelSelection} />
          <ArrowRightIcon className="size-3 shrink-0 opacity-70" aria-hidden />
          <HandoffEndpoint
            selection={info.targetModelSelection}
            className={failed ? "line-through" : "text-foreground/84"}
          />
        </button>
        <span aria-hidden className="h-px min-w-0 flex-1 bg-[color:var(--color-border-light)]" />
      </div>
      <DisclosureRegion open={open} contentClassName="pt-3">
        <ProviderHandoffDetails info={info} />
      </DisclosureRegion>
    </div>
  );
});
