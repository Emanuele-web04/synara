// FILE: ContinuousHandoffPath.tsx
// Purpose: Secondary, accessible provider-route disclosure in the chat header.
// Layer: Chat handoff presentation

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";
import {
  compressContinuousHandoffPath,
  type ContinuousHandoffPathStep,
} from "~/lib/continuousHandoffPath";
import { cn } from "~/lib/utils";
import { ProviderIcon } from "../ProviderIcon";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TRANSITION_GLYPH = { start: "", forward: "→", return: "↩", gap: "…" } as const;

export function ContinuousHandoffPath({
  steps,
  currentProvider,
  compact = false,
}: {
  readonly steps: ReadonlyArray<ContinuousHandoffPathStep>;
  readonly currentProvider: ProviderKind;
  readonly compact?: boolean;
}) {
  if (steps.length < 2) return null;
  const currentName = PROVIDER_DISPLAY_NAMES[currentProvider];
  const route = steps
    .map((step) =>
      `${TRANSITION_GLYPH[step.transition]} ${PROVIDER_DISPLAY_NAMES[step.provider]}`.trim(),
    )
    .join(" ");
  const spokenRoute = steps
    .map((step) => {
      const name = PROVIDER_DISPLAY_NAMES[step.provider];
      if (step.transition === "return") return `return to ${name}`;
      if (step.transition === "gap") return `history gap, ${name}`;
      return name;
    })
    .join(", ");
  const tokens = compressContinuousHandoffPath(steps, compact ? 2 : 4);
  const isCurrent = (step: ContinuousHandoffPathStep) =>
    step.key === steps.at(-1)?.key && step.provider === currentProvider;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  className="shrink-0 gap-1 px-1 font-normal [-webkit-app-region:no-drag]"
                  aria-label={`Provider path: ${spokenRoute}. Current provider: ${currentName}. Show full history.`}
                  data-handoff-path
                />
              }
            >
              <span aria-hidden className="flex items-center gap-1">
                {tokens.map((token) =>
                  token.kind === "overflow" ? (
                    <span
                      key="overflow"
                      className="text-ui-xs text-muted-foreground/65 tabular-nums"
                      data-handoff-path-overflow={token.hiddenCount}
                    >
                      +{token.hiddenCount}
                    </span>
                  ) : (
                    <span key={token.step.key} className="inline-flex items-center gap-1">
                      {token.step.transition !== "start" ? (
                        <span
                          className="text-ui-xs text-muted-foreground/55"
                          data-handoff-path-transition={token.step.transition}
                        >
                          {TRANSITION_GLYPH[token.step.transition]}
                        </span>
                      ) : null}
                      <span
                        className={cn(
                          "inline-flex size-5 items-center justify-center rounded-md",
                          isCurrent(token.step) ? "bg-secondary ring-1 ring-border" : "opacity-55",
                        )}
                        data-handoff-path-provider={token.step.provider}
                        data-handoff-path-current={isCurrent(token.step) || undefined}
                      >
                        <ProviderIcon
                          provider={token.step.provider}
                          tone="header"
                          className="size-3 opacity-100"
                        />
                      </span>
                    </span>
                  ),
                )}
              </span>
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="bottom" className="max-w-80">
          <span>
            {route}. Current provider: {currentName}. Click for full history.
          </span>
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" side="bottom" className="w-64 max-w-[90vw]">
        <PopoverTitle className="text-ui font-medium">Provider path</PopoverTitle>
        <ol aria-label="Full provider history" className="mt-3 space-y-2 text-ui-sm">
          {steps.map((step) => (
            <li key={step.key} className="flex items-center gap-2">
              <span aria-hidden className="w-3 shrink-0 text-muted-foreground">
                {TRANSITION_GLYPH[step.transition]}
              </span>
              <ProviderIcon provider={step.provider} tone="header" className="size-3.5 shrink-0" />
              <span>{PROVIDER_DISPLAY_NAMES[step.provider]}</span>
              {step.transition === "return" ? (
                <span className="text-ui-xs text-muted-foreground">(return)</span>
              ) : null}
              {step.transition === "gap" ? (
                <span className="text-ui-xs text-muted-foreground">(history gap)</span>
              ) : null}
              {isCurrent(step) ? (
                <span className="ml-auto text-ui-xs text-muted-foreground">Current</span>
              ) : null}
            </li>
          ))}
        </ol>
      </PopoverPopup>
    </Popover>
  );
}
