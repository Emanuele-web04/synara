// FILE: ToolCallGroupSummaryRow.tsx
// Purpose: Collapsed summary disclosure for a settled run of tool calls
//          ("Ran 2 commands, Edited 2 files"); expands to the individual rows.
// Layer: Web chat presentation component
// Exports: ToolCallGroupSummaryRow
// Depends on: DisclosureRegion/DisclosureChevron (shared disclosure motion)

import { useEffect, useState, type ReactNode } from "react";

import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import type { ToolCallGroupSummary } from "./toolCallGroup.logic";

export function ToolCallGroupSummaryRow(props: {
  summary: ToolCallGroupSummary;
  open: boolean;
  onToggle: (open: boolean) => void;
  fontSizePx: number;
  renderChildren: () => ReactNode;
}) {
  const { summary, open, onToggle, fontSizePx, renderChildren } = props;
  const [keepChildrenMounted, setKeepChildrenMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setKeepChildrenMounted(true);
      return;
    }
    if (!keepChildrenMounted) return;
    const cleanup = window.setTimeout(
      () => setKeepChildrenMounted(false),
      DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS,
    );
    return () => window.clearTimeout(cleanup);
  }, [keepChildrenMounted, open]);

  const shouldRenderChildren = open || keepChildrenMounted;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex items-center gap-1 py-0.5 text-left text-muted-foreground/70 transition-colors duration-200 hover:text-muted-foreground/90"
        style={{ fontSize: `${fontSizePx}px` }}
        onClick={() => onToggle(!open)}
      >
        <span>{summary.label}</span>
        <DisclosureChevron open={open} className="text-muted-foreground/55" />
      </button>
      <DisclosureRegion open={open}>
        {shouldRenderChildren ? renderChildren() : null}
      </DisclosureRegion>
    </div>
  );
}
