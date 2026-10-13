// FILE: inlineVisualSpec.ts
// Purpose: The component spec an agent sends to `synara_show_visual` instead of raw HTML:
//          a list of typed blocks (stats, charts, tables, lists, calculators, choices, tabs)
//          that clients draw with their own components.
// Layer: Cross-process contract (validated by the gateway tool, decoded by the web renderer)
// Exports: InlineVisualSpec, InlineVisualBlock, InlineVisualLeafBlock, limits

import { Schema } from "effect";

/** JSON size limit for a component spec; specs carry data, not markup, so they stay small. */
export const INLINE_VISUAL_MAX_SPEC_BYTES = 64 * 1024;
export const INLINE_VISUAL_MAX_BLOCKS = 16;

const Text = (maxLength: number) =>
  Schema.Trim.check(Schema.isNonEmpty()).check(Schema.isMaxLength(maxLength));
const OptionalText = (maxLength: number) => Schema.optional(Text(maxLength));
const List = <S extends Schema.Top>(item: S, min: number, max: number) =>
  Schema.Array(item).check(Schema.isMinLength(min)).check(Schema.isMaxLength(max));

/** Semantic tone. `accent` marks the one thing that matters; the rest are statuses. */
export const InlineVisualTone = Schema.Literals([
  "neutral",
  "accent",
  "success",
  "warning",
  "danger",
]);
export type InlineVisualTone = typeof InlineVisualTone.Type;

const MarkdownBlock = Schema.Struct({
  type: Schema.Literal("markdown"),
  text: Text(8_000),
});

const StatsBlock = Schema.Struct({
  type: Schema.Literal("stats"),
  items: List(
    Schema.Struct({
      label: Text(60),
      value: Text(40),
      /** A short change or context line under the value, such as "+12% vs last week". */
      detail: OptionalText(80),
      trend: Schema.optional(Schema.Literals(["up", "down", "flat"])),
      tone: Schema.optional(InlineVisualTone),
    }),
    1,
    6,
  ),
});

const BarChartBlock = Schema.Struct({
  type: Schema.Literal("bar-chart"),
  title: OptionalText(120),
  /** Shown after each value, such as "ms" or "%". */
  unit: OptionalText(12),
  items: List(
    Schema.Struct({
      label: Text(60),
      value: Schema.Finite,
      /** The earlier value ("before") of a before/after comparison, drawn as a faint bar above. */
      baseline: Schema.optional(Schema.Finite),
      highlight: Schema.optional(Schema.Boolean),
    }),
    1,
    40,
  ),
  /** Bars keep the given order unless this is "value", which sorts them largest first. */
  sort: Schema.optional(Schema.Literals(["none", "value"])),
  /** Legend names for baselines and values, such as "Before" and "After". */
  baselineLabel: OptionalText(24),
  valueLabel: OptionalText(24),
  /** Which direction of change is good; colors each item's change from its baseline. */
  better: Schema.optional(Schema.Literals(["lower", "higher"])),
});

const LineChartBlock = Schema.Struct({
  type: Schema.Literal("line-chart"),
  title: OptionalText(120),
  unit: OptionalText(12),
  /** X-axis labels; every series has one value (or null for a gap) per label. */
  labels: List(Text(24), 2, 200),
  series: List(
    Schema.Struct({
      name: Text(40),
      values: List(Schema.NullOr(Schema.Finite), 2, 200),
    }),
    1,
    6,
  ),
});

const TableCell = Schema.NullOr(
  Schema.Union([Schema.String.check(Schema.isMaxLength(400)), Schema.Finite]),
);

const TableBlock = Schema.Struct({
  type: Schema.Literal("table"),
  title: OptionalText(120),
  columns: List(
    Schema.Struct({
      label: Text(60),
      /** Numbers right-align and use tabular figures; percent appends "%". */
      format: Schema.optional(Schema.Literals(["text", "number", "percent"])),
    }),
    1,
    10,
  ),
  rows: List(List(TableCell, 1, 10), 1, 200),
  /** Index of a row to emphasize. */
  highlightRow: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const ListBlock = Schema.Struct({
  type: Schema.Literal("list"),
  title: OptionalText(120),
  /** checklist items can be ticked by the reader; steps show progress down a rail. */
  style: Schema.optional(Schema.Literals(["bullets", "numbered", "checklist", "steps"])),
  items: List(
    Schema.Struct({
      title: Text(200),
      detail: OptionalText(400),
      /** checklist: done starts ticked. steps: the item's state on the rail. */
      status: Schema.optional(Schema.Literals(["done", "current", "pending", "failed"])),
      tone: Schema.optional(InlineVisualTone),
    }),
    1,
    40,
  ),
});

const CalloutBlock = Schema.Struct({
  type: Schema.Literal("callout"),
  tone: Schema.optional(Schema.Literals(["info", "success", "warning", "danger"])),
  title: OptionalText(120),
  text: Text(1_000),
});

const CompareBlock = Schema.Struct({
  type: Schema.Literal("compare"),
  options: List(
    Schema.Struct({
      title: Text(60),
      subtitle: OptionalText(80),
      /** The recommended option; at most one should set it. */
      highlight: Schema.optional(Schema.Boolean),
      points: List(
        Schema.Struct({
          label: Text(60),
          value: Text(120),
        }),
        1,
        12,
      ),
    }),
    2,
    4,
  ),
});

/** Letters, digits, and underscores, as formulas read them. */
const CalculatorId = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/));

const CalculatorBlock = Schema.Struct({
  type: Schema.Literal("calculator"),
  title: OptionalText(120),
  inputs: List(
    Schema.Struct({
      /** Name used in output formulas. */
      id: CalculatorId,
      label: Text(60),
      value: Schema.Finite,
      min: Schema.optional(Schema.Finite),
      max: Schema.optional(Schema.Finite),
      step: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
      unit: OptionalText(12),
    }),
    1,
    8,
  ),
  outputs: List(
    Schema.Struct({
      /** Lets later outputs use this result in their formulas. */
      id: Schema.optional(CalculatorId),
      label: Text(60),
      /**
       * Arithmetic over input ids and earlier output ids: + - * / % ^, parentheses,
       * min max round floor ceil abs sqrt.
       */
      formula: Text(300),
      unit: OptionalText(12),
      /** Leading currency or symbol, such as "$". */
      prefix: OptionalText(4),
      decimals: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
      emphasis: Schema.optional(Schema.Boolean),
    }),
    1,
    8,
  ),
});

const ChoicesBlock = Schema.Struct({
  type: Schema.Literal("choices"),
  prompt: OptionalText(200),
  options: List(
    Schema.Struct({
      label: Text(80),
      description: OptionalText(160),
      /** What is sent as the reader's next message; defaults to the label. */
      message: OptionalText(1_000),
    }),
    1,
    6,
  ),
});

export const InlineVisualLeafBlock = Schema.Union([
  MarkdownBlock,
  StatsBlock,
  BarChartBlock,
  LineChartBlock,
  TableBlock,
  ListBlock,
  CalloutBlock,
  CompareBlock,
  CalculatorBlock,
  ChoicesBlock,
]);
export type InlineVisualLeafBlock = typeof InlineVisualLeafBlock.Type;

/** Tabs hold leaf blocks only, so specs stay one level deep. */
const TabsBlock = Schema.Struct({
  type: Schema.Literal("tabs"),
  tabs: List(
    Schema.Struct({
      label: Text(40),
      blocks: List(InlineVisualLeafBlock, 1, INLINE_VISUAL_MAX_BLOCKS),
    }),
    2,
    6,
  ),
});

export const InlineVisualBlock = Schema.Union([InlineVisualLeafBlock, TabsBlock]);
export type InlineVisualBlock = typeof InlineVisualBlock.Type;

export const InlineVisualSpec = Schema.Struct({
  blocks: List(InlineVisualBlock, 1, INLINE_VISUAL_MAX_BLOCKS),
});
export type InlineVisualSpec = typeof InlineVisualSpec.Type;

export const INLINE_VISUAL_BLOCK_TYPES = [
  "markdown",
  "stats",
  "bar-chart",
  "line-chart",
  "table",
  "list",
  "callout",
  "compare",
  "calculator",
  "choices",
  "tabs",
] as const satisfies ReadonlyArray<InlineVisualBlock["type"]>;
