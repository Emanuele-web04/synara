// FILE: inlineVisualTools.ts
// Purpose: The `synara_show_visual` gateway tool: an agent publishes a visual into its own
//          running turn, shown inline above its final reply. Usually a component spec the
//          app draws natively; a self-contained HTML document for anything the spec can't express.
// Layer: Agent Gateway tool (provider-neutral; every provider with the thread-scoped gateway)
// Exports: makeAgentGatewayInlineVisualTools, INLINE_VISUALS_PER_TURN_LIMIT

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";

import {
  INLINE_VISUAL_DEFAULT_HEIGHT,
  INLINE_VISUAL_BLOCK_TYPES,
  INLINE_VISUAL_EMBED_FENCE,
  INLINE_VISUAL_MAX_HEIGHT,
  INLINE_VISUAL_MAX_HTML_BYTES,
  INLINE_VISUAL_MAX_SPEC_BYTES,
  INLINE_VISUAL_MAX_TITLE_LENGTH,
  INLINE_VISUAL_MIN_HEIGHT,
  INLINE_VISUAL_TOOL_NAME,
  InlineVisualSpec,
  type InlineVisualActivityPayload,
  type InlineVisualBlock,
  type InlineVisualFormat,
} from "@synara/contracts";
import { compileInlineVisualFormula } from "@synara/shared/inlineVisualFormula";
import { Effect, Schema, Semaphore } from "effect";

import { writeInlineVisual } from "../inlineVisualStore.ts";
import { stableGatewayDigest } from "./creationUtils.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText, readNumberArg } from "./toolInput.ts";
import type { ToolEntry } from "./toolRuntime.ts";

/** A turn that keeps publishing visuals is almost certainly looping; refuse past this. */
export const INLINE_VISUALS_PER_TURN_LIMIT = 6;
const TRACKED_TURNS_MAX = 512;

const DESCRIPTION = [
  "Show a finished visual - stats, a chart, a table, a comparison, a checklist, a small calculator, or follow-up choices - inside your reply, as part of the answer. Use it only when a visual reads faster than text.",
  `Call it before writing the reply. The result gives a short \`\`\`${INLINE_VISUAL_EMBED_FENCE} fenced block: write that block in your reply on its own lines exactly where the visual belongs, like a paragraph, with your text before and after it. A visual you do not place shows above the reply.`,
  "The reader sees the visual, so keep the text around it brief: state the key finding in words and do not describe the visual or say where it is.",
  // The component spec: the default.
  "Send blocks: a list of components the app draws with its own design system, in its theme and font size. Use blocks for everything they can express; the title is not shown.",
  "Block types (field? is optional): " +
    "markdown {text} short prose, lists, links, or a code fence. " +
    "stats {items:[{label, value, detail?, trend?: up|down|flat, tone?}]} 1-6 headline numbers as tiles. " +
    "bar-chart {title?, unit?, items:[{label, value, baseline?, highlight?}], sort?: none|value, baselineLabel?, valueLabel?, better?: lower|higher} horizontal bars; highlight the one that matters. For before/after, give each item its old value as baseline and its new value as value instead of separate before and after bars; name them with baselineLabel and valueLabel, and set better so changes are colored. " +
    "line-chart {title?, unit?, labels:[x labels], series:[{name, values:[number|null, one per label]}]} trends over time. " +
    "table {title?, columns:[{label, format?: text|number|percent}], rows:[[cell per column]], highlightRow?} cells are strings, numbers, or null. " +
    "list {title?, style?: bullets|numbered|checklist|steps, items:[{title, detail?, status?: done|current|pending|failed, tone?}]} a checklist the reader can tick, or steps on a progress rail. " +
    "callout {tone?: info|success|warning|danger, title?, text} one important note. " +
    "compare {options:[{title, subtitle?, highlight?, points:[{label, value}]}]} 2-4 options side by side; use the same point labels in each and highlight the recommended one. " +
    "calculator {title?, inputs:[{id, label, value, min?, max?, step?, unit?}], outputs:[{id?, label, formula, prefix?, unit?, decimals?, emphasis?}]} live results as the reader edits inputs; formulas use input ids and the ids of outputs above them, + - * / % ^, parentheses, and min max round floor ceil abs sqrt. " +
    "choices {prompt?, options:[{label, description?, message?}]} 1-6 next steps; a click sends message (default label) as the reader's next message. " +
    "tabs {tabs:[{label, blocks:[...]}]} 2-6 views of the same subject; tabs hold any block except tabs.",
  "tone is neutral, accent, success, warning, or danger: accent marks the one thing that matters, the rest are statuses. Keep labels short, put units in unit instead of every value, and order blocks as the reader should read them: the answer first, then detail.",
  // The HTML fallback.
  "Send html instead of blocks only for what blocks cannot draw, such as a diagram, a map, or a custom interactive view: one complete, self-contained HTML document with inline <style> and <script>.",
  "Network loads are blocked: fetch, remote URLs, external scripts, fonts, and images do not load. Draw with inline SVG, canvas, or HTML, and embed images as data: URIs.",
  "Link clicks open http(s) URLs in the reader's browser. Navigating the frame stops the visual; the page cannot open windows or show dialogs, and storage is in-memory only.",
  "Placement: borderless on the chat background, left-aligned with your reply text, as wide as the reply column (728px on desktop, about 360px on phones). Start the page with a short h3 when it needs a heading. No outer card, border, padding, banner, or page background.",
  "Base styles already match the app: text at --font-size, h1-h4, p, small, hr, tables, and buttons, inputs, selects, checkboxes, and ranges with a visible focus ring. Helpers: class num right-aligns numbers; muted is secondary text; a .segmented group of buttons with aria-pressed is a segmented control; .tag with data-tone accent, success, warning, or danger is a status tag.",
  "Theme variables on :root follow the app's theme live: --background --foreground --muted-foreground --secondary --border --rule (hairlines) --surface (a faint panel fill) --primary --primary-foreground --success --warning --destructive --ring --radius --font-sans --font-mono --font-size, and for data --chart-accent --chart-muted --chart-grid --series-1 to --series-6.",
  'Use one accent (--chart-accent) for what matters and --chart-muted for the rest. Size by content, not the column: draw inline SVG at its viewBox size (max-width:100%;height:auto) and never use preserveAspectRatio="none". Keep text at the inherited size and never under 11px.',
  "Diagrams: nodes are rounded boxes with --surface fill and a --rule outline, edges in --muted-foreground with arrowheads, at most one highlighted node in --chart-accent; lay them out left to right and stack them below about 560px.",
  "Let content set the page's height: no 100vh; the frame grows to fit. Respect prefers-reduced-motion.",
].join(" ");

interface InlineVisualDraft {
  readonly title: string;
  readonly format: InlineVisualFormat;
  /** What is stored: the normalized spec JSON, or the HTML document. */
  readonly source: string;
  readonly height: number;
  readonly byteLength: number;
}

const decodeSpec = Schema.decodeUnknownSync(InlineVisualSpec);

function readInlineVisualDraft(args: Record<string, unknown>): InlineVisualDraft {
  const rawTitle = args.title;
  if (typeof rawTitle !== "string") {
    throw new ToolInputError('Argument "title" must be a non-empty string.');
  }
  // Control characters would render as junk in the transcript label.
  const title = rawTitle
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length === 0) {
    throw new ToolInputError('Argument "title" must be a non-empty string.');
  }
  if (title.length > INLINE_VISUAL_MAX_TITLE_LENGTH) {
    throw new ToolInputError(
      `Argument "title" must be at most ${INLINE_VISUAL_MAX_TITLE_LENGTH} characters.`,
    );
  }
  const hasBlocks = args.blocks !== undefined && args.blocks !== null;
  const hasHtml = args.html !== undefined && args.html !== null;
  if (hasBlocks === hasHtml) {
    throw new ToolInputError('Send exactly one of "blocks" or "html".');
  }
  if (hasBlocks) {
    const blocks = readSpecBlocks(args.blocks);
    const source = JSON.stringify({ blocks });
    const byteLength = Buffer.byteLength(source, "utf8");
    if (byteLength > INLINE_VISUAL_MAX_SPEC_BYTES) {
      throw new ToolInputError(
        `The blocks are ${Math.ceil(byteLength / 1024)} KiB; the limit is ${INLINE_VISUAL_MAX_SPEC_BYTES / 1024} KiB. Show fewer rows or points.`,
      );
    }
    return { title, format: "components", source, height: estimateSpecHeight(blocks), byteLength };
  }
  const html = args.html;
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new ToolInputError('Argument "html" must be a non-empty HTML document.');
  }
  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength > INLINE_VISUAL_MAX_HTML_BYTES) {
    throw new ToolInputError(
      `The page is ${Math.ceil(byteLength / 1024)} KiB; the limit is ${INLINE_VISUAL_MAX_HTML_BYTES / 1024} KiB. Remove embedded data or simplify the page.`,
    );
  }
  const requestedHeight = readNumberArg(args, "height");
  return { title, format: "html", source: html, height: clampHeight(requestedHeight), byteLength };
}

function clampHeight(height: number | undefined): number {
  return Math.min(
    INLINE_VISUAL_MAX_HEIGHT,
    Math.max(INLINE_VISUAL_MIN_HEIGHT, Math.round(height ?? INLINE_VISUAL_DEFAULT_HEIGHT)),
  );
}

/**
 * The schema checks shapes; this adds the rules that span fields, so a spec
 * that passes always renders as the agent meant. Errors name the block path.
 */
function readSpecBlocks(raw: unknown): ReadonlyArray<InlineVisualBlock> {
  let blocks: ReadonlyArray<InlineVisualBlock>;
  try {
    blocks = decodeSpec({ blocks: raw }).blocks;
  } catch (error) {
    throw new ToolInputError(
      `Invalid blocks: ${errorText(error)}\nBlock types: ${INLINE_VISUAL_BLOCK_TYPES.join(", ")}.`,
    );
  }
  const check = (block: InlineVisualBlock, path: string) => {
    const fail = (message: string): never => {
      throw new ToolInputError(`Invalid blocks: ${message}\n  at ${path}`);
    };
    switch (block.type) {
      case "line-chart":
        block.series.forEach((series, index) => {
          if (series.values.length !== block.labels.length) {
            fail(
              `series ${index} "${series.name}" has ${series.values.length} values for ${block.labels.length} labels`,
            );
          }
        });
        break;
      case "table":
        block.rows.forEach((row, index) => {
          if (row.length !== block.columns.length) {
            fail(`row ${index} has ${row.length} cells for ${block.columns.length} columns`);
          }
        });
        if (block.highlightRow !== undefined && block.highlightRow >= block.rows.length) {
          fail(`highlightRow ${block.highlightRow} is past the last row`);
        }
        break;
      case "calculator": {
        const ids = new Set<string>();
        for (const input of block.inputs) {
          if (ids.has(input.id)) fail(`id "${input.id}" is used twice`);
          ids.add(input.id);
          if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
            fail(`input "${input.id}" has min above max`);
          }
        }
        // Outputs read inputs and the outputs above them, in order.
        block.outputs.forEach((output) => {
          const compiled = compileInlineVisualFormula(output.formula, ids);
          if (!compiled.ok) fail(`formula of "${output.label}": ${compiled.error}`);
          if (output.id !== undefined) {
            if (ids.has(output.id)) fail(`id "${output.id}" is used twice`);
            ids.add(output.id);
          }
        });
        break;
      }
      case "tabs":
        block.tabs.forEach((tab, tabIndex) =>
          tab.blocks.forEach((child, index) =>
            check(child, `${path}.tabs[${tabIndex}].blocks[${index}]`),
          ),
        );
        break;
    }
  };
  blocks.forEach((block, index) => check(block, `blocks[${index}]`));
  return blocks;
}

/** Space held while the spec loads, so the transcript grows once rather than jumping. */
function estimateSpecHeight(blocks: ReadonlyArray<InlineVisualBlock>): number {
  const GAP = 16;
  const estimate = (block: InlineVisualBlock): number => {
    const titled = "title" in block && block.title !== undefined ? 28 : 0;
    switch (block.type) {
      case "markdown":
        return 24 * Math.max(1, Math.ceil(block.text.length / 90));
      case "stats":
        return 88;
      case "bar-chart":
        return (
          titled +
          block.items.length * (block.items.some((item) => item.baseline !== undefined) ? 40 : 28)
        );
      case "line-chart":
        return titled + 220;
      case "table":
        return titled + 36 + Math.min(block.rows.length, 12) * 34;
      case "list":
        return titled + block.items.length * (block.items.some((item) => item.detail) ? 48 : 30);
      case "callout":
        return 64;
      case "compare":
        return 72 + Math.max(...block.options.map((option) => option.points.length)) * 28;
      case "calculator":
        return titled + 32 + block.inputs.length * 52 + block.outputs.length * 32;
      case "choices":
        return (block.prompt ? 28 : 0) + block.options.length * 36;
      case "tabs":
        return (
          44 +
          Math.max(
            ...block.tabs.map((tab) =>
              tab.blocks.reduce((sum, child) => sum + estimate(child) + GAP, -GAP),
            ),
          )
        );
    }
  };
  return clampHeight(blocks.reduce((sum, block) => sum + estimate(block) + GAP, -GAP));
}

export interface AppendInlineVisualActivityInput {
  readonly threadId: string;
  readonly turnId: string;
  /** Stable for identical content in the same turn, so a retried call is the same command. */
  readonly digest: string;
  readonly payload: InlineVisualActivityPayload;
}

export interface InlineVisualToolsInput {
  readonly attachmentsDir: string;
  /**
   * Records the visual on the caller's thread. Succeeds when this exact visual
   * was already recorded by an earlier attempt of the same call.
   */
  readonly appendVisualActivity: (
    input: AppendInlineVisualActivityInput,
  ) => Effect.Effect<void, unknown>;
}

export function makeAgentGatewayInlineVisualTools(
  input: InlineVisualToolsInput,
): ReadonlyArray<ToolEntry> {
  // Visual ids published per running turn. In memory only: a restart resets
  // the count, which is fine for a guard against a looping agent.
  // Hold creation through activity append and rollback: overlapping retries must
  // never delete a document referenced by a successful publication.
  const publicationLock = Semaphore.makeUnsafe(1);
  const visualsByTurn = new Map<string, Set<string>>();
  const turnVisuals = (key: string) => {
    let visuals = visualsByTurn.get(key);
    if (visuals === undefined) {
      while (visualsByTurn.size >= TRACKED_TURNS_MAX) {
        visualsByTurn.delete(visualsByTurn.keys().next().value!);
      }
      visuals = new Set();
      visualsByTurn.set(key, visuals);
    }
    return visuals;
  };

  const showVisual: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: INLINE_VISUAL_TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: INLINE_VISUAL_MAX_TITLE_LENGTH,
            description: "Short name for the visual; also its accessible name.",
          },
          blocks: {
            type: "array",
            minItems: 1,
            description: `Components to draw, in reading order (see the tool description). At most ${INLINE_VISUAL_MAX_SPEC_BYTES / 1024} KiB as JSON. Send this or html.`,
            items: {
              type: "object",
              properties: { type: { type: "string", enum: [...INLINE_VISUAL_BLOCK_TYPES] } },
              required: ["type"],
            },
          },
          html: {
            type: "string",
            minLength: 1,
            description: `Only when blocks cannot express the visual: one complete, self-contained HTML document, at most ${INLINE_VISUAL_MAX_HTML_BYTES / 1024} KiB.`,
          },
          height: {
            type: "integer",
            minimum: INLINE_VISUAL_MIN_HEIGHT,
            maximum: INLINE_VISUAL_MAX_HEIGHT,
            description: `html only: expected height in CSS pixels at the 728px column. Space is reserved at this height until the page reports its own. Defaults to ${INLINE_VISUAL_DEFAULT_HEIGHT}.`,
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      annotations: {
        title: "Show a visual",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const draft = yield* Effect.try({
          try: () => readInlineVisualDraft(args),
          catch: (cause) => cause,
        });
        const turnId = context.callerTurnId;
        if (turnId === null) {
          return yield* Effect.fail(
            new ToolInputError("Visuals can only be shown during an active turn."),
          );
        }
        const sha256 = createHash("sha256").update(draft.source, "utf8").digest("hex");
        const digest = stableGatewayDigest({
          kind: "inline-visual",
          threadId: context.callerThreadId,
          turnId,
          sha256,
          title: draft.title,
          height: draft.height,
        });
        const visualId = `vis_${digest}`;
        const turnKey = `${context.callerThreadId}\u0000${turnId}`;
        const published = turnVisuals(turnKey);
        if (!published.has(visualId) && published.size >= INLINE_VISUALS_PER_TURN_LIMIT) {
          return yield* Effect.fail(
            new ToolInputError(
              `This turn already shows ${INLINE_VISUALS_PER_TURN_LIMIT} visuals. Combine them into one visual instead.`,
            ),
          );
        }

        const stored = yield* Effect.tryPromise({
          try: () =>
            writeInlineVisual({
              attachmentsDir: input.attachmentsDir,
              threadId: context.callerThreadId,
              visualId,
              html: draft.source,
            }),
          catch: (cause) =>
            new ToolInputError(`The visual could not be saved: ${errorText(cause)}`),
        });
        // Only a file this call created is removed on failure: an identical
        // retry shares the id, and its earlier success must keep its page.
        const discardNewFile = Effect.promise(() =>
          stored.existed ? Promise.resolve() : rm(stored.filePath, { force: true }),
        );

        // Stop may have ended the turn while the page was written; a stopped
        // turn must not gain a row.
        yield* context.assertCallerTurnActive().pipe(Effect.tapError(() => discardNewFile));
        yield* input
          .appendVisualActivity({
            threadId: context.callerThreadId,
            turnId,
            digest,
            payload: {
              visualId,
              format: draft.format,
              title: draft.title,
              height: draft.height,
              byteLength: draft.byteLength,
              sha256,
            },
          })
          .pipe(
            Effect.tapError(() => discardNewFile),
            Effect.mapError(
              (cause) => new ToolInputError(`The visual could not be shown: ${errorText(cause)}`),
            ),
          );
        published.add(visualId);
        const embed = `\`\`\`${INLINE_VISUAL_EMBED_FENCE}\n${visualId}\n\`\`\``;
        return mcpToolResultJson({
          visualId,
          title: draft.title,
          embed,
          message: `Place the visual in your reply by writing this block on its own lines where it belongs:\n${embed}\nState the key finding in words around it; do not describe the visual or say where it is.`,
        });
      }).pipe(
        publicationLock.withPermit,
        Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
      ),
  };

  return [showVisual];
}
