// FILE: InlineVisualCalculator.tsx
// Purpose: The calculator block of a native inline visual: labeled inputs (sliders when
//          bounded) and outputs recomputed from the agent's formulas as the reader edits.
// Layer: Chat transcript row content
// Exports: InlineVisualCalculator

import type { InlineVisualBlock } from "@synara/contracts";
import { compileInlineVisualFormula } from "@synara/shared/inlineVisualFormula";
import { useMemo } from "react";

import { cn } from "~/lib/utils";

import { Input } from "../ui/input";
import { Slider } from "../ui/slider";
import { formatVisualNumber, useInlineVisualState } from "./inlineVisualBlocks.logic";
import { InlineVisualSurface } from "./InlineVisualSurface";
import { useTranslation } from "~/i18n";

type CalculatorBlock = Extract<InlineVisualBlock, { type: "calculator" }>;

export function InlineVisualCalculator({
  block,
  stateKey,
}: {
  readonly block: CalculatorBlock;
  readonly stateKey: string;
}) {
  const { t, formatLocale } = useTranslation();

  const [values, setValues] = useInlineVisualState<Record<string, number>>(stateKey, () =>
    Object.fromEntries(block.inputs.map((input) => [input.id, input.value])),
  );
  // The gateway refused specs whose formulas do not compile; an output that
  // still fails (an older spec) shows a dash rather than breaking the block.
  const formulas = useMemo(() => {
    const ids = new Set(block.inputs.map((input) => input.id));
    return block.outputs.map((output) => {
      const compiled = compileInlineVisualFormula(output.formula, ids);
      if (output.id !== undefined) ids.add(output.id);
      return compiled.ok ? compiled.formula : null;
    });
  }, [block]);
  // In order: an output with an id is visible to the formulas below it.
  const results: number[] = [];
  const scope: Record<string, number> = { ...values };
  block.outputs.forEach((output, index) => {
    const result = formulas[index]?.evaluate(scope) ?? Number.NaN;
    results.push(result);
    if (output.id !== undefined) scope[output.id] = result;
  });
  const setValue = (id: string, value: number) =>
    setValues((previous) => ({ ...previous, [id]: value }));

  return (
    <InlineVisualSurface title={block.title}>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
        <div className="flex min-w-0 flex-col gap-3.5">
          {block.inputs.map((input) => {
            const value = values[input.id] ?? input.value;
            const bounded = input.min !== undefined && input.max !== undefined;
            const label = t("common:symbol6", {
              value0: input.label,
              value1: input.unit ? ` (${input.unit})` : "",
            });
            return (
              <label key={input.id} className="flex min-w-0 flex-col gap-1.5">
                <span className="flex items-baseline justify-between gap-3 text-chat-sm">
                  <span className="truncate text-muted-foreground">{input.label}</span>
                  {bounded ? (
                    <span className="font-medium tabular-nums">
                      {formatVisualNumber(value, { unit: input.unit }, formatLocale)}
                    </span>
                  ) : null}
                </span>
                {bounded ? (
                  <Slider
                    value={value}
                    min={input.min!}
                    max={input.max!}
                    step={input.step ?? defaultStep(input.min!, input.max!)}
                    aria-label={label}
                    onValueChange={(next) => setValue(input.id, next)}
                  />
                ) : (
                  <Input
                    type="number"
                    inputMode="decimal"
                    aria-label={label}
                    value={Number.isFinite(value) ? value : ""}
                    {...(input.min !== undefined ? { min: input.min } : {})}
                    {...(input.max !== undefined ? { max: input.max } : {})}
                    {...(input.step !== undefined ? { step: input.step } : {})}
                    className="tabular-nums"
                    onChange={(event) => setValue(input.id, event.currentTarget.valueAsNumber)}
                  />
                )}
              </label>
            );
          })}
        </div>
        <dl className="m-0 flex min-w-0 flex-col justify-center gap-2 rounded-xl bg-[var(--surface)] px-3.5 py-3">
          {block.outputs.map((output, index) => {
            const result = results[index] ?? Number.NaN;
            return (
              <div
                key={`${output.label}:${index}`}
                className={cn(
                  "flex min-w-0 items-baseline justify-between gap-3",
                  output.emphasis && "flex-col items-start gap-0.5",
                )}
              >
                <dt className="truncate text-chat-sm text-muted-foreground">{output.label}</dt>
                <dd
                  className={cn(
                    "m-0 tabular-nums",
                    output.emphasis
                      ? "text-chat-display font-semibold tracking-tight"
                      : "text-chat font-medium",
                  )}
                  aria-live="polite"
                >
                  {formatVisualNumber(
                    result,
                    {
                      decimals: output.decimals,
                      prefix: output.prefix,
                      unit: output.unit,
                    },
                    formatLocale,
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </InlineVisualSurface>
  );
}

/** About a hundred stops across the range, on a round number. */
function defaultStep(min: number, max: number): number {
  const rough = (max - min) / 100;
  if (!(rough > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((factor) => factor * magnitude).find((step) => step >= rough)!;
}
