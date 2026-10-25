// FILE: InlineVisualBlocks.tsx
// Purpose: A component-spec inline visual drawn with the app's own components: fetches the
//          spec, then renders its blocks (prose, stats, charts, tables, lists, callouts,
//          comparisons, calculators, follow-up choices, tabs) in the reply's flow.
// Layer: Chat transcript row content
// Exports: InlineVisualBlocks

import {
  INLINE_VISUAL_DEFAULT_HEIGHT,
  type InlineVisualActivityPayload,
  type InlineVisualBlock,
  type InlineVisualLeafBlock,
  type ThreadId,
} from "@synara/contracts";
import { INLINE_VISUAL_SERIES_COLORS } from "@synara/shared/inlineVisual";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, type CSSProperties, type ReactNode } from "react";

import { useTheme } from "~/hooks/useTheme";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  MinusIcon,
  TriangleAlertIcon,
  XIcon,
} from "~/lib/icons";
import { inlineVisualQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { SegmentedPicker } from "../SegmentedPicker";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ComposerChoiceRow } from "./ComposerChoiceRow";
import { InlineVisualCalculator } from "./InlineVisualCalculator";
import { InlineVisualBarChart, InlineVisualLineChart } from "./InlineVisualCharts";
import { InlineVisualSurface, toneColor, toneTextClassName } from "./InlineVisualSurface";
import { InlineVisualTable } from "./InlineVisualTable";
import { decodeInlineVisualSpec, useInlineVisualState } from "./inlineVisualBlocks.logic";
import { InlineVisualEmbedContext } from "./inlineVisualEmbedContext";

export interface InlineVisualBlocksActions {
  /** Markdown links and file paths resolve against this. */
  readonly cwd: string | undefined;
  /** Sends a follow-up choice as the reader's next message; absent where sending is not possible. */
  readonly onSendChoice?: ((message: string) => void) | undefined;
}

export function InlineVisualBlocks({
  threadId,
  visual,
  actions,
}: {
  readonly threadId: ThreadId;
  readonly visual: InlineVisualActivityPayload;
  readonly actions: InlineVisualBlocksActions;
}) {
  const { resolvedTheme } = useTheme();
  const source = useQuery(inlineVisualQueryOptions({ threadId, visualId: visual.visualId }));
  const spec = useMemo(
    () => (source.data === undefined ? undefined : decodeInlineVisualSpec(source.data)),
    [source.data],
  );
  const seriesStyle = useMemo(
    () =>
      Object.fromEntries(
        INLINE_VISUAL_SERIES_COLORS[resolvedTheme].map((color, index) => [
          `--series-${index + 2}`,
          color,
        ]),
      ) as CSSProperties,
    [resolvedTheme],
  );

  if (spec === undefined) {
    return source.isError ? (
      <BlocksNotice
        title={visual.title}
        message="Visual unavailable."
        {...((source.error as { retryable?: boolean } | null)?.retryable === false
          ? {}
          : { onRetry: () => void source.refetch() })}
      />
    ) : (
      <div
        role="status"
        aria-label={`Loading ${visual.title}`}
        className="animate-pulse rounded-2xl bg-[color:color-mix(in_srgb,var(--foreground)_4%,transparent)]"
        style={{ height: visual.height || INLINE_VISUAL_DEFAULT_HEIGHT }}
      />
    );
  }
  if (spec === null) {
    return <BlocksNotice title={visual.title} message="This visual needs a newer Synara." />;
  }
  return (
    <figure
      className="inline-visual-blocks m-0 flex min-w-0 flex-col gap-4 text-chat"
      style={seriesStyle}
      aria-label={visual.title}
      data-inline-visual-blocks=""
    >
      {/* A visual never embeds another one; a fence in its prose stays code. */}
      <InlineVisualEmbedContext.Provider value={null}>
        {spec.blocks.map((block, index) => (
          <Block
            key={index}
            block={block}
            stateKey={`${visual.visualId}:${index}`}
            actions={actions}
          />
        ))}
      </InlineVisualEmbedContext.Provider>
    </figure>
  );
}

function BlocksNotice(props: {
  readonly title: string;
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-muted-foreground text-ui-sm"
      role="status"
    >
      <span className="max-w-[40%] truncate text-foreground">{props.title}</span>
      <span className="min-w-0 flex-1">{props.message}</span>
      {props.onRetry ? (
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function Block({
  block,
  stateKey,
  actions,
}: {
  readonly block: InlineVisualBlock;
  readonly stateKey: string;
  readonly actions: InlineVisualBlocksActions;
}) {
  if (block.type === "tabs")
    return <TabsBlock block={block} stateKey={stateKey} actions={actions} />;
  return <LeafBlock block={block} stateKey={stateKey} actions={actions} />;
}

function LeafBlock({
  block,
  stateKey,
  actions,
}: {
  readonly block: InlineVisualLeafBlock;
  readonly stateKey: string;
  readonly actions: InlineVisualBlocksActions;
}) {
  switch (block.type) {
    case "markdown":
      return (
        <div className="inline-visual-markdown">
          <ChatMarkdown text={block.text} cwd={actions.cwd} isStreaming={false} />
        </div>
      );
    case "stats":
      return <StatsBlock block={block} />;
    case "bar-chart":
      return <InlineVisualBarChart block={block} />;
    case "line-chart":
      return <InlineVisualLineChart block={block} />;
    case "table":
      return <InlineVisualTable block={block} stateKey={stateKey} />;
    case "list":
      return <ListBlock block={block} stateKey={stateKey} />;
    case "callout":
      return <CalloutBlock block={block} />;
    case "compare":
      return <CompareBlock block={block} />;
    case "calculator":
      return <InlineVisualCalculator block={block} stateKey={stateKey} />;
    case "choices":
      return <ChoicesBlock block={block} stateKey={stateKey} onSendChoice={actions.onSendChoice} />;
  }
}

type BlockOf<T extends InlineVisualBlock["type"]> = Extract<InlineVisualBlock, { type: T }>;

function StatsBlock({ block }: { readonly block: BlockOf<"stats"> }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2.5">
      {block.items.map((item, index) => (
        <div
          key={`${item.label}:${index}`}
          className={cn(
            "flex min-w-0 flex-col gap-0.5 rounded-2xl bg-[var(--surface)] px-4 py-3",
            item.tone === "accent" &&
              "bg-[color:color-mix(in_srgb,var(--chart-accent)_9%,var(--background))]",
          )}
        >
          <span className="line-clamp-2 text-chat-sm text-muted-foreground">{item.label}</span>
          <span
            className="truncate text-chat-display font-semibold tracking-tight tabular-nums"
            title={item.value}
          >
            {item.value}
          </span>
          {item.detail || item.trend ? (
            <span
              className={cn(
                "flex min-w-0 items-start gap-1 text-chat-sm",
                toneTextClassName(item.tone === "accent" ? undefined : item.tone),
              )}
            >
              {item.trend === "up" ? (
                <ArrowUpIcon className="mt-[0.15em] size-3.5 shrink-0" aria-label="up" />
              ) : item.trend === "down" ? (
                <ArrowDownIcon className="mt-[0.15em] size-3.5 shrink-0" aria-label="down" />
              ) : item.trend === "flat" ? (
                <MinusIcon className="mt-[0.15em] size-3.5 shrink-0" aria-label="flat" />
              ) : null}
              {item.detail ? <span className="line-clamp-2">{item.detail}</span> : null}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ListBlock({
  block,
  stateKey,
}: {
  readonly block: BlockOf<"list">;
  readonly stateKey: string;
}) {
  const style = block.style ?? "bullets";
  const [checked, setChecked] = useInlineVisualState<ReadonlyArray<boolean>>(stateKey, () =>
    block.items.map((item) => item.status === "done"),
  );
  const content =
    style === "steps" ? (
      <ol className="m-0 flex list-none flex-col p-0">
        {block.items.map((item, index) => (
          <li key={index} className="relative flex gap-3 pb-3.5 last:pb-0">
            {index < block.items.length - 1 ? (
              <span
                aria-hidden
                className="absolute top-6 bottom-0.5 left-[0.6875rem] w-px bg-[var(--rule)]"
              />
            ) : null}
            <StepMarker status={item.status} />
            <div className="min-w-0 pt-0.5">
              <div className={cn(item.status === "current" && "font-medium")}>{item.title}</div>
              {item.detail ? (
                <div className="text-chat-sm text-muted-foreground">{item.detail}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    ) : style === "checklist" ? (
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {block.items.map((item, index) => (
          <li key={index}>
            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox
                className="mt-[0.2em]"
                checked={checked[index] ?? false}
                onCheckedChange={(next) =>
                  setChecked((previous) =>
                    block.items.map((_, at) => (at === index ? next : (previous[at] ?? false))),
                  )
                }
              />
              <span className="min-w-0">
                <span
                  className={cn(
                    "transition-colors",
                    checked[index] && "text-muted-foreground line-through",
                  )}
                >
                  {item.title}
                </span>
                {item.detail ? (
                  <span className="block text-chat-sm text-muted-foreground">{item.detail}</span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
    ) : (
      <ListTag numbered={style === "numbered"}>
        {block.items.map((item, index) => (
          <li key={index} className="flex gap-2.5">
            <span
              aria-hidden
              className={cn(
                "shrink-0 tabular-nums",
                style === "numbered"
                  ? "min-w-4 text-muted-foreground"
                  : "mt-[0.6em] size-1.5 rounded-full bg-[var(--chart-muted)]",
              )}
              style={
                style === "numbered" ? undefined : { background: toneColor(item.tone) ?? undefined }
              }
            >
              {style === "numbered" ? `${index + 1}.` : null}
            </span>
            <span className="min-w-0">
              <span
                className={
                  item.tone && item.tone !== "neutral" ? toneTextClassName(item.tone) : undefined
                }
              >
                {item.title}
              </span>
              {item.detail ? (
                <span className="block text-chat-sm text-muted-foreground">{item.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ListTag>
    );
  return block.title !== undefined || style === "steps" || style === "checklist" ? (
    <InlineVisualSurface
      title={block.title}
      aside={
        // The tick count rides on the title row; without a title it would sit alone.
        style === "checklist" && block.title !== undefined ? (
          <span className="text-chat-sm text-muted-foreground tabular-nums">
            {checked.filter(Boolean).length}/{block.items.length}
          </span>
        ) : null
      }
    >
      {content}
    </InlineVisualSurface>
  ) : (
    content
  );
}

function ListTag({
  numbered,
  children,
}: {
  readonly numbered: boolean;
  readonly children: ReactNode;
}) {
  const className = "m-0 flex list-none flex-col gap-1.5 p-0";
  return numbered ? (
    <ol className={className}>{children}</ol>
  ) : (
    <ul className={className}>{children}</ul>
  );
}

function StepMarker({ status }: { readonly status: BlockOf<"list">["items"][number]["status"] }) {
  const base =
    "relative z-10 flex size-[1.375rem] shrink-0 items-center justify-center rounded-full";
  switch (status) {
    case "done":
      return (
        <span className={cn(base, "bg-[var(--success)] text-[var(--background)]")}>
          <CheckIcon className="size-3" aria-label="done" />
        </span>
      );
    case "failed":
      return (
        <span className={cn(base, "bg-[var(--destructive)] text-[var(--background)]")}>
          <XIcon className="size-3" aria-label="failed" />
        </span>
      );
    case "current":
      return (
        <span
          className={cn(base, "border-2 border-[var(--chart-accent)] bg-[var(--background)]")}
          aria-label="current"
        >
          <span className="size-2 rounded-full bg-[var(--chart-accent)]" />
        </span>
      );
    default:
      return (
        <span
          className={cn(base, "border border-[var(--chart-muted)] bg-[var(--background)]")}
          aria-label="pending"
        />
      );
  }
}

const CALLOUT_ICONS = {
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
  danger: CircleAlertIcon,
} as const;

function CalloutBlock({ block }: { readonly block: BlockOf<"callout"> }) {
  const tone = block.tone ?? "info";
  const Icon = CALLOUT_ICONS[tone];
  const color = toneColor(tone)!;
  return (
    <aside
      className="flex gap-3 rounded-2xl px-4 py-3"
      style={{ background: `color-mix(in srgb, ${color} 9%, var(--background))` }}
    >
      <Icon className="mt-[0.2em] size-4 shrink-0" style={{ color }} aria-hidden />
      <div className="min-w-0">
        {block.title ? <div className="font-medium">{block.title}</div> : null}
        <div className={cn(block.title && "text-chat-sm text-muted-foreground")}>{block.text}</div>
      </div>
    </aside>
  );
}

function CompareBlock({ block }: { readonly block: BlockOf<"compare"> }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-2.5">
      {block.options.map((option, index) => (
        <InlineVisualSurface
          key={`${option.title}:${index}`}
          highlighted={option.highlight ?? false}
          className={cn(
            option.highlight &&
              "bg-[color:color-mix(in_srgb,var(--chart-accent)_5%,var(--background))]",
          )}
        >
          <div className="mb-3">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{option.title}</span>
              {option.highlight ? (
                <span className="shrink-0 rounded-full bg-[color:color-mix(in_srgb,var(--chart-accent)_14%,transparent)] px-2 py-px text-chat-sm font-medium text-[color:color-mix(in_srgb,var(--chart-accent)_80%,var(--foreground))]">
                  Recommended
                </span>
              ) : null}
            </div>
            {option.subtitle ? (
              <div className="text-chat-sm text-muted-foreground">{option.subtitle}</div>
            ) : null}
          </div>
          <dl className="m-0 flex flex-col gap-2">
            {option.points.map((point, pointIndex) => (
              <div key={`${point.label}:${pointIndex}`} className="min-w-0">
                <dt className="text-chat-sm text-muted-foreground">{point.label}</dt>
                <dd className="m-0">{point.value}</dd>
              </div>
            ))}
          </dl>
        </InlineVisualSurface>
      ))}
    </div>
  );
}

function ChoicesBlock({
  block,
  stateKey,
  onSendChoice,
}: {
  readonly block: BlockOf<"choices">;
  readonly stateKey: string;
  readonly onSendChoice: ((message: string) => void) | undefined;
}) {
  const [chosen, setChosen] = useInlineVisualState<number | null>(stateKey, null);
  // A selection is consumed synchronously before React commits its disabled state.
  const selectionPending = useRef(false);
  return (
    <div className="flex flex-col gap-1">
      {block.prompt ? (
        <div className="mb-1 text-chat-sm text-muted-foreground">{block.prompt}</div>
      ) : null}
      <div className="-mx-2 flex flex-col">
        {block.options.map((option, index) => (
          <ComposerChoiceRow
            key={`${option.label}:${index}`}
            shortcut={index + 1}
            label={option.label}
            description={option.description ?? null}
            {...(chosen === null ? {} : { selected: chosen === index })}
            disabled={onSendChoice === undefined || (chosen !== null && chosen !== index)}
            onSelect={() => {
              if (onSendChoice === undefined || chosen !== null || selectionPending.current) return;
              selectionPending.current = true;
              setChosen(index);
              onSendChoice(option.message ?? option.label);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function TabsBlock({
  block,
  stateKey,
  actions,
}: {
  readonly block: BlockOf<"tabs">;
  readonly stateKey: string;
  readonly actions: InlineVisualBlocksActions;
}) {
  const [active, setActive] = useInlineVisualState(stateKey, "0");
  const tab = block.tabs[Number(active)] ?? block.tabs[0]!;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SegmentedPicker
        value={active}
        options={block.tabs.map((entry, index) => ({ value: String(index), label: entry.label }))}
        onValueChange={setActive}
        ariaLabel="Views"
        className="max-w-md"
      />
      <div className="flex min-w-0 flex-col gap-4">
        {tab.blocks.map((child, index) => (
          <LeafBlock
            key={`${active}:${index}`}
            block={child}
            stateKey={`${stateKey}:${active}:${index}`}
            actions={actions}
          />
        ))}
      </div>
    </div>
  );
}
