// FILE: ToolCallGroupSummaryRow.tsx
// Purpose: One-line disclosure for a run of tool calls, read as a verb summary
//          ("Read 2 files, ran 3 commands, 1 failed, 1 running") that expands
//          to the rows. LiveToolCallLine is the working indicator's line for
//          the call of the moment: its icon and sentence, or its failure.
// Layer: Web chat presentation component
// Exports: ToolCallGroupSummaryRow, LiveToolCallLine
// Depends on: DisclosureRegion/DisclosureChevron (shared disclosure motion)

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "../../i18n";

import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import {
  BackgroundTrayIcon,
  BotIcon,
  FileReadIcon,
  GlobeIcon,
  type LucideIcon,
  McpIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WebSearchIcon,
  WorkingIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { extractWebFetchUrl } from "../../lib/toolCallLabel";
import { LinkChipIcon } from "../LinkChipIcon";
import { McpServerIcon } from "./McpServerIcon";
import type { WorkLogEntry } from "../../session-logic";
import { multiFileEditLabel, type ToolCallGroupSummary } from "./toolCallGroup.logic";
import {
  renderWorkEntryIcon,
  renderWorkEntrySentence,
  workEntryDisplayParts,
  workEntryFailureMetaText,
  workEntryLeftIcon,
} from "./TimelineWorkEntryRow";

// One glyph per kind, matching the expanded rows; a mixed group wears the
// working hammer. Tool calls and uncategorized calls keep their first entry's
// own mark (MCP server, Synara, browser).
function summaryIcon(summary: ToolCallGroupSummary): LucideIcon {
  switch (summary.iconCategory) {
    case "read":
      return FileReadIcon;
    case "search":
      return SearchIcon;
    case "web-search":
      return WebSearchIcon;
    case "command":
      return TerminalIcon;
    case "edit":
      return PencilIcon;
    case "agent":
      return BotIcon;
    case "background":
      return BackgroundTrayIcon;
    case "fetch":
      return GlobeIcon;
    case "mixed":
      return WorkingIcon;
    case "tool":
    case "other":
      return workEntryLeftIcon(summary.iconEntry);
  }
}

// The size-4 icon slot a tool line wears: a fetched site's favicon, an MCP
// server's mark, or the given glyph.
function ToolCallLineIcon(props: {
  icon: LucideIcon;
  entry: WorkLogEntry;
  showFavicon: boolean;
  category?: string | undefined;
}) {
  const { icon: Icon, entry, showFavicon, category } = props;
  const webFetchUrl = showFavicon ? extractWebFetchUrl(entry) : null;
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center"
      aria-hidden
      data-tool-group-icon={category}
    >
      {webFetchUrl ? (
        <LinkChipIcon url={webFetchUrl} className="size-3.5" />
      ) : Icon === McpIcon && entry.mcpServer ? (
        <McpServerIcon serverName={entry.mcpServer} className="size-3.5" />
      ) : (
        renderWorkEntryIcon(Icon, "size-3.5")
      )}
    </span>
  );
}

// One tool call on one line for the working indicator: its own icon (favicon,
// MCP server mark or tool glyph) and its sentence, truncated. A failed call
// adds the failure the expanded row states ("Failed · exit 1"); the indicator
// sets the failure tone around it.
export function LiveToolCallLine(props: { entry: WorkLogEntry; failed: boolean }) {
  const { t } = useTranslation();
  const { entry, failed } = props;
  const failureMetaText = failed ? workEntryFailureMetaText(entry) : null;
  return (
    <>
      <ToolCallLineIcon icon={workEntryLeftIcon(entry)} entry={entry} showFavicon />
      <span className="min-w-0 truncate" data-working-tool-call="true">
        {multiFileEditLabel(entry, t) ?? renderWorkEntrySentence(workEntryDisplayParts(entry, t))}
        {failureMetaText ? (
          <>
            {" · "}
            <span className="text-destructive" data-tool-failure-meta="true">
              {failureMetaText}
            </span>
          </>
        ) : null}
      </span>
    </>
  );
}

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
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 py-0.5 text-left leading-5 transition-colors duration-200 hover:text-foreground",
          MUTED_LABEL_TEXT_CLASS_NAME,
        )}
        style={{ fontSize: `${fontSizePx}px` }}
        onClick={() => onToggle(!open)}
      >
        {/* The group wears its kind's glyph; a fetched site keeps its favicon. */}
        <ToolCallLineIcon
          icon={summaryIcon(summary)}
          entry={summary.iconEntry}
          showFavicon={summary.iconCategory === "fetch"}
          category={summary.iconCategory}
        />
        <span className="min-w-0 truncate">
          {summary.label}
          {summary.failedLabel ? (
            <>
              , <span className="text-destructive">{summary.failedLabel}</span>
            </>
          ) : null}
          {summary.runningLabel ? (
            <>
              , <span data-tool-group-running="true">{summary.runningLabel}</span>
            </>
          ) : null}
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
