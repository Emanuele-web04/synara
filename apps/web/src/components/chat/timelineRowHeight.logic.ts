// FILE: timelineRowHeight.logic.ts
// Purpose: Size hints for transcript rows the virtualizer has not measured yet.
//          A content-aware estimate keeps the scroll range close to the real
//          transcript. Validated plain-message measurements can survive remounts;
//          mutable rows are re-estimated instead of borrowing stale geometry.
// Layer: Web chat presentation helpers
// Exports: estimateTimelineRowHeight, createTimelineRowHeightEstimator,
//          rememberTimelineRowHeight, TimelineRowHeightLayout

import { getChatTranscriptUserMessageLineHeightPx } from "./chatTypography";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { USER_MESSAGE_COLLAPSED_MAX_LINES } from "./userMessageCollapse";

/** The default 46rem chat column; used until a rendered row reports its real width. */
export const DEFAULT_TIMELINE_ROW_WIDTH_PX = 736;
// Estimate invisible rows from a bounded sample; never scan the full transcript text.
const MAX_TEXT_SAMPLE_CHARS = 4096;

export interface TimelineRowHeightLayout {
  /** Width of a transcript row (the chat column), in CSS pixels. */
  readonly rowWidthPx: number;
  readonly chatFontSizePx: number;
  readonly fontKey?: string;
}

// Calibrated against measured rows of real transcripts at the default 13px chat font
// and the 46rem column: median error about 3%, total transcript height within 1%.
const GLYPH_WIDTH_EM = 0.5;
const PROSE_LINE_HEIGHT_EM = 1.7;
const PARAGRAPH_GAP_EM = 1.4;
const CODE_LINE_HEIGHT_EM = 1.55;
const CODE_BLOCK_CHROME_PX = 40;
const USER_BUBBLE_WIDTH_RATIO = 0.75;
const USER_CHROME_PX = 64;
// "Show more" under a clamped user message: one chat-sized line plus its top margin.
const USER_SHOW_MORE_EM = 1.625;
const USER_SHOW_MORE_MARGIN_PX = 4;
const ASSISTANT_CHROME_PX = 50;
const TURN_HEADER_PX = 30;
const CHANGED_FILES_CARD_PX = 50;
const CHANGED_FILE_ROW_PX = 42;
const MAX_ESTIMATED_CHANGED_FILE_ROWS = 8;
const ATTACHMENT_STRIP_PX = 140;
const WORK_ROW_PX = 38;
const WORK_ENTRY_PX = 24;
const MAX_ESTIMATED_WORK_ENTRIES = 4;
const MESSAGE_SEGMENT_CHROME_PX = 16;
const PROPOSED_PLAN_CHROME_PX = 96;
const USER_INPUT_ROW_PX = 72;
const USER_INPUT_EXCHANGE_PX = 56;
const WORKING_ROW_PX = 40;
const WORKTREE_SETUP_ROW_PX = 48;
const WORKTREE_SETUP_STEP_PX = 32;
const MIN_ROW_HEIGHT_PX = 24;

/** Height of Markdown-ish text laid out in `widthPx`, counting fences and blank lines. */
function estimateTextHeight(text: string, widthPx: number, fontSizePx: number): number {
  const sample = text.length > MAX_TEXT_SAMPLE_CHARS ? text.slice(0, MAX_TEXT_SAMPLE_CHARS) : text;
  const charsPerLine = Math.max(8, Math.floor(widthPx / (fontSizePx * GLYPH_WIDTH_EM)));
  let proseLines = 0;
  let blankLines = 0;
  let codeLines = 0;
  let codeBlocks = 0;
  let inCode = false;
  let start = 0;
  while (start <= sample.length) {
    const newline = sample.indexOf("\n", start);
    const end = newline === -1 ? sample.length : newline;
    let lineStart = start;
    let lineEnd = end;
    while (lineStart < lineEnd && sample.charCodeAt(lineStart) <= 32) lineStart += 1;
    while (lineEnd > lineStart && sample.charCodeAt(lineEnd - 1) <= 32) lineEnd -= 1;
    if (sample.startsWith("```", lineStart)) {
      if (!inCode) codeBlocks += 1;
      inCode = !inCode;
    } else if (inCode) {
      codeLines += 1;
    } else if (lineEnd === lineStart) {
      blankLines += 1;
    } else {
      proseLines += Math.ceil((lineEnd - lineStart) / charsPerLine);
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  const sampledHeight =
    proseLines * fontSizePx * PROSE_LINE_HEIGHT_EM +
    blankLines * fontSizePx * PARAGRAPH_GAP_EM +
    codeLines * fontSizePx * CODE_LINE_HEIGHT_EM +
    codeBlocks * CODE_BLOCK_CHROME_PX;
  return sampledHeight * (sample.length > 0 ? text.length / sample.length : 1);
}

function estimateWorkEntriesHeight(entryCount: number): number {
  return entryCount > 0
    ? WORK_ROW_PX + WORK_ENTRY_PX * Math.min(entryCount - 1, MAX_ESTIMATED_WORK_ENTRIES)
    : 0;
}

/** Best-effort pixel height of a row before it renders. Never used once measured. */
export function estimateTimelineRowHeight(
  row: MessagesTimelineRow,
  layout: TimelineRowHeightLayout,
): number {
  const { rowWidthPx, chatFontSizePx } = layout;
  let height: number;
  switch (row.kind) {
    case "message": {
      const { message } = row;
      if (message.role === "user") {
        // Long user messages render collapsed to a fixed number of lines.
        const clampPx =
          USER_MESSAGE_COLLAPSED_MAX_LINES *
          getChatTranscriptUserMessageLineHeightPx(chatFontSizePx);
        const textPx = estimateTextHeight(
          message.text,
          rowWidthPx * USER_BUBBLE_WIDTH_RATIO,
          chatFontSizePx,
        );
        height =
          USER_CHROME_PX +
          (textPx > clampPx
            ? clampPx + USER_SHOW_MORE_MARGIN_PX + chatFontSizePx * USER_SHOW_MORE_EM
            : textPx) +
          ((message.attachments?.length ?? 0) > 0 ? ATTACHMENT_STRIP_PX : 0);
        break;
      }
      const changedFiles = row.assistantTurnDiffSummary?.files.length ?? 0;
      height =
        ASSISTANT_CHROME_PX +
        estimateTextHeight(message.text, rowWidthPx, chatFontSizePx) +
        (row.turnHeader ? TURN_HEADER_PX : 0) +
        (changedFiles > 0
          ? CHANGED_FILES_CARD_PX +
            CHANGED_FILE_ROW_PX * Math.min(changedFiles, MAX_ESTIMATED_CHANGED_FILE_ROWS)
          : 0) +
        estimateWorkEntriesHeight(row.leadingWorkEntries?.length ?? 0) +
        estimateWorkEntriesHeight(row.inlineWorkEntries?.length ?? 0);
      break;
    }
    case "message-segment":
      height =
        MESSAGE_SEGMENT_CHROME_PX +
        estimateTextHeight(
          row.message.textSegments?.[row.segmentIndex]?.text ?? row.message.text,
          rowWidthPx,
          chatFontSizePx,
        );
      break;
    case "work":
      height = estimateWorkEntriesHeight(Math.max(1, row.groupedEntries.length));
      break;
    case "proposed-plan":
      height =
        PROPOSED_PLAN_CHROME_PX +
        estimateTextHeight(row.proposedPlan.planMarkdown, rowWidthPx, chatFontSizePx);
      break;
    case "user-input":
      height = USER_INPUT_ROW_PX + USER_INPUT_EXCHANGE_PX * row.entry.userInputExchange.length;
      break;
    case "working":
    case "working-header":
      height = WORKING_ROW_PX;
      break;
    case "worktree-setup":
      height = WORKTREE_SETUP_ROW_PX + WORKTREE_SETUP_STEP_PX * row.steps.length;
      break;
    default:
      // Additive row kinds use the list's existing fallback until actually measured.
      height = 90;
  }
  return Math.max(MIN_ROW_HEIGHT_PX, Math.round(height));
}

// Only unchanged, settled plain messages can retain a measured height across mounts.
// Live/work/rich rows have disclosure or external geometry that a message ID cannot validate.
const MAX_REMEMBERED_ROW_HEIGHTS = 20_000;
type MessageRow = Extract<MessagesTimelineRow, { kind: "message" }>;
const rememberedRowHeights = new Map<
  string,
  { height: number; message: WeakRef<MessageRow["message"]>; copyButton: boolean }
>();
const plainMessageContent = new WeakMap<MessageRow["message"], boolean>();

export interface TimelineRowHeightCacheOptions {
  readonly namespace?: string | undefined;
  readonly canRememberRow?: (row: MessagesTimelineRow) => boolean;
}

function isPlainSettledMessage(row: MessagesTimelineRow): row is MessageRow {
  if (
    row.kind !== "message" ||
    row.message.streaming ||
    row.assistantCopyStreaming ||
    row.assistantTurnInProgress ||
    row.turnHeader ||
    row.turnEndMarker ||
    row.assistantTurnDiffSummary ||
    row.leadingWorkEntries?.length ||
    row.inlineWorkEntries?.length ||
    row.collapsedTurnItems?.length ||
    row.message.attachments?.length
  )
    return false;
  let plain = plainMessageContent.get(row.message);
  if (plain === undefined) {
    const text = row.message.text;
    // Rich Markdown and multiline user contexts can own independent disclosures.
    plain =
      text.length <= MAX_TEXT_SAMPLE_CHARS &&
      !text.includes("`") &&
      !text.includes("~~~") &&
      !text.includes("![") &&
      !text.includes("<") &&
      (row.message.role !== "user" || !text.includes("\n"));
    plainMessageContent.set(row.message, plain);
  }
  return plain;
}

function rowHeightCacheKey(
  namespace: string,
  rowId: string,
  layout: TimelineRowHeightLayout,
): string {
  return `${namespace.length}:${namespace}:${Math.round(layout.rowWidthPx)}:${layout.chatFontSizePx}:${layout.fontKey ?? ""}:${rowId}`;
}

export function rememberTimelineRowHeight(
  rowId: string,
  layout: TimelineRowHeightLayout,
  heightPx: number,
  options: { namespace?: string | undefined; row: MessagesTimelineRow; allowed?: boolean },
): void {
  if (
    !(heightPx > 0) ||
    !options.namespace ||
    options.allowed === false ||
    !isPlainSettledMessage(options.row)
  )
    return;
  const key = rowHeightCacheKey(options.namespace, rowId, layout);
  rememberedRowHeights.delete(key);
  rememberedRowHeights.set(key, {
    height: heightPx,
    message: new WeakRef(options.row.message),
    copyButton: options.row.showAssistantCopyButton,
  });
  if (rememberedRowHeights.size > MAX_REMEMBERED_ROW_HEIGHTS) {
    const oldest = rememberedRowHeights.keys().next().value;
    if (oldest !== undefined) rememberedRowHeights.delete(oldest);
  }
}

/** Cache estimates per immutable row, and reuse only validated plain-row measurements. */
export function createTimelineRowHeightEstimator(
  getLayout: () => TimelineRowHeightLayout,
  options: TimelineRowHeightCacheOptions = {},
): (row: MessagesTimelineRow) => number {
  const estimates = new WeakMap<MessagesTimelineRow, { layoutKey: string; height: number }>();
  return (row) => {
    const layout = getLayout();
    if (
      options.namespace &&
      (options.canRememberRow?.(row) ?? true) &&
      isPlainSettledMessage(row)
    ) {
      const remembered = rememberedRowHeights.get(
        rowHeightCacheKey(options.namespace, row.id, layout),
      );
      if (
        remembered?.message.deref() === row.message &&
        remembered.copyButton === row.showAssistantCopyButton
      )
        return remembered.height;
    }
    const layoutKey = `${Math.round(layout.rowWidthPx)}:${layout.chatFontSizePx}:${layout.fontKey ?? ""}`;
    const cached = estimates.get(row);
    if (cached?.layoutKey === layoutKey) return cached.height;
    const height = estimateTimelineRowHeight(row, layout);
    estimates.set(row, { layoutKey, height });
    return height;
  };
}
