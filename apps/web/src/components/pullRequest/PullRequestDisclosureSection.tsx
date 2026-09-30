// FILE: PullRequestDisclosureSection.tsx
// Purpose: The collapsible section the GitHub item details are built from (Description, Checks,
//          Comments): a hairline-topped heading with the chevron riding to its right and an
//          optional count, over the shared Collapsible (and its disclosure motion).
// Layer: Pull request presentation
// Exports: PullRequestDisclosureSection

import { useState, type ReactNode } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { cn } from "~/lib/utils";
import { PR_META_TEXT_CLASS_NAME, PR_SECTION_TITLE_TEXT_CLASS_NAME } from "./pullRequestText";

export function PullRequestDisclosureSection({
  label,
  count,
  children,
  defaultOpen: defaultOpenProp,
}: {
  label: string;
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const defaultOpen = defaultOpenProp ?? true;
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {/* Reference layout: title first, chevron riding to its right, count after — the
          section reads as a heading with an affordance, not a tree node. */}
      <CollapsibleTrigger
        className={cn(
          PR_SECTION_TITLE_TEXT_CLASS_NAME,
          "flex w-full items-center gap-1.5 border-t border-border/60 px-5 py-3 text-left font-medium",
        )}
      >
        <span>{label}</span>
        <DisclosureChevron open={open} />
        {count === undefined ? null : (
          <span className={cn(PR_META_TEXT_CLASS_NAME, "tabular-nums text-muted-foreground")}>
            {count}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="px-5 pb-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
