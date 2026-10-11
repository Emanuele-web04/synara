// FILE: ToolCallGroupSummaryRow.tsx
// Purpose: One-line disclosure for a run of tool calls. Settled runs read as a
//          verb summary ("Read 2 files, ran 3 commands, 1 failed"); a live run
//          wears its latest status or call instead. Both expand to the rows.
// Layer: Web chat presentation component
// Exports: ToolCallGroupSummaryRow
// Depends on: DisclosureRegion/DisclosureChevron (shared disclosure motion)

import { useEffect, useState, type ReactNode } from "react";

import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import {
  BotIcon,
  FileIcon,
  GlobeIcon,
  type LucideIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WorkingIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { extractWebFetchUrl } from "../../lib/toolCallLabel";
import { LinkChipIcon } from "../LinkChipIcon";
import type { WorkLogEntry } from "../../session-logic";
import { multiFileEditLabel, type ToolCallGroupSummary } from "./toolCallGroup.logic";
import {
  renderWorkEntryIcon,
  renderWorkEntrySentence,
  workEntryDisplayParts,
  workEntryLeftIcon,
} from "./TimelineWorkEntryRow";

// One glyph per kind, matching the expanded rows; a mixed group wears the
// working hammer. Tool calls and uncategorized calls keep their first entry's
// own mark (MCP server, Synara, browser).
function summaryIcon(summary: ToolCallGroupSummary): LucideIcon {
  switch (summary.iconCategory) {
    case "read":
      return FileIcon;
    case "search":
      return SearchIcon;
    case "command":
      return TerminalIcon;
    case "edit":
      return PencilIcon;
    case "agent":
      return BotIcon;
    case "fetch":
      return GlobeIcon;
    case "mixed":
      return WorkingIcon;
    case "tool":
    case "other":
      return workEntryLeftIcon(summary.iconEntry);
  }
}

// A group the tool summary does not describe (e.g. background tasks) passes
// its own line and glyph instead.
type GroupLine =
  | { summary: ToolCallGroupSummary; label?: never; icon?: never }
  | { summary?: never; label: ReactNode; icon: LucideIcon };

export function ToolCallGroupSummaryRow(
  props: GroupLine & {
    // Selected status or call of a live run, shown instead of the summary.
    liveEntry?: WorkLogEntry | null;
    open: boolean;
    onToggle: (open: boolean) => void;
    fontSizePx: number;
    renderChildren: () => ReactNode;
  },
) {
  const { liveEntry, open, onToggle, fontSizePx, renderChildren } = props;
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

  // A live line wears its call's own icon; a settled group its kind's glyph.
  // A fetched site keeps its favicon.
  const summary = props.summary ?? null;
  const iconEntry = liveEntry ?? summary?.iconEntry ?? null;
  const iconWebFetchUrl = iconEntry ? extractWebFetchUrl(iconEntry) : null;
  const showFavicon =
    iconWebFetchUrl !== null && (liveEntry != null || summary?.iconCategory === "fetch");
  const Icon = liveEntry
    ? workEntryLeftIcon(liveEntry)
    : summary
      ? summaryIcon(summary)
      : props.icon!;
  const liveMultiFileLabel = liveEntry ? multiFileEditLabel(liveEntry) : null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 py-0.5 text-left transition-colors duration-200 hover:text-foreground",
          MUTED_LABEL_TEXT_CLASS_NAME,
        )}
        style={{ fontSize: `${fontSizePx}px` }}
        onClick={() => onToggle(!open)}
      >
        <span
          className="flex size-4 shrink-0 items-center justify-center"
          aria-hidden
          data-tool-group-icon={liveEntry ? undefined : summary?.iconCategory}
        >
          {showFavicon && iconWebFetchUrl ? (
            <LinkChipIcon url={iconWebFetchUrl} className="size-3.5" />
          ) : (
            renderWorkEntryIcon(Icon, "size-3.5")
          )}
        </span>
        <span className="min-w-0 truncate" data-tool-group-live={liveEntry ? "true" : undefined}>
          {liveEntry ? (
            (liveMultiFileLabel ?? renderWorkEntrySentence(workEntryDisplayParts(liveEntry)))
          ) : !summary ? (
            props.label
          ) : (
            <>
              {summary.label}
              {summary.failedLabel ? (
                <>
                  , <span className="text-destructive">{summary.failedLabel}</span>
                </>
              ) : null}
            </>
          )}
        </span>
        {/* One step quieter than the label, matching the per-row disclosure chevron. */}
        <DisclosureChevron open={open} className="text-muted-foreground/70" />
      </button>
      <DisclosureRegion open={open}>
        {shouldRenderChildren ? renderChildren() : null}
      </DisclosureRegion>
    </div>
  );
}
