// FILE: ProviderHandoffTrail.tsx
// Purpose: Shows the provider path for continuous, in-thread handoffs.
// Layer: Chat shell header
// Depends on: shared provider branding and tooltip primitives

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";
import React from "react";

import { ArrowRightIcon, Undo2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ProviderIcon } from "../ProviderIcon";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import type { ProviderHandoffTrailEntry } from "~/lib/threadHandoff";
export type { ProviderHandoffTrailEntry } from "~/lib/threadHandoff";

export interface ProviderHandoffTrailPresentation {
  readonly first: ProviderHandoffTrailEntry | null;
  readonly trailing: ReadonlyArray<ProviderHandoffTrailEntry>;
  readonly hiddenCount: number;
}

const HEADER_TRAIL_LIMIT = 5;
const HEADER_TRAILING_COUNT = 3;

export function resolveProviderHandoffTrailPresentation(
  trail: ReadonlyArray<ProviderHandoffTrailEntry>,
): ProviderHandoffTrailPresentation {
  if (trail.length <= HEADER_TRAIL_LIMIT) {
    return { first: null, trailing: trail, hiddenCount: 0 };
  }

  const first = trail[0] ?? null;
  const trailing = trail.slice(-HEADER_TRAILING_COUNT);
  return {
    first,
    trailing,
    hiddenCount: trail.length - trailing.length - (first ? 1 : 0),
  };
}

export function describeProviderHandoffTrail(
  trail: ReadonlyArray<ProviderHandoffTrailEntry>,
): string {
  if (trail.length === 0) return "";

  return trail
    .map((entry, index) => {
      const providerName = PROVIDER_DISPLAY_NAMES[entry.provider];
      if (index === 0) return `Started with ${providerName}`;
      return `${entry.isReturn ? "returned to" : "continued with"} ${providerName}`;
    })
    .join(", ");
}

function TrailConnector({ isReturn }: { readonly isReturn: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center",
        isReturn ? "text-[var(--color-text-accent)]" : "text-muted-foreground/55",
      )}
      title={isReturn ? "Returned to an earlier provider" : "Continued with another provider"}
    >
      {isReturn ? <Undo2Icon className="size-3" /> : <ArrowRightIcon className="size-3" />}
    </span>
  );
}

function ProviderStep({
  entry,
  current,
  showCurrentLabel,
}: {
  readonly entry: ProviderHandoffTrailEntry;
  readonly current: boolean;
  readonly showCurrentLabel: boolean;
}) {
  const providerName = PROVIDER_DISPLAY_NAMES[entry.provider];

  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center justify-center gap-1 rounded-[4px]",
        current ? "px-0.5" : "w-4",
      )}
      title={current ? `Current provider: ${providerName}` : providerName}
    >
      <ProviderIcon provider={entry.provider} tone="header" className="size-3 shrink-0" />
      {current && showCurrentLabel ? (
        <>
          <span className="max-w-20 truncate font-medium text-foreground">{providerName}</span>
          <span className="text-[9px] font-normal text-muted-foreground">Current</span>
        </>
      ) : null}
    </span>
  );
}

function HeaderTrail({
  trail,
  compact,
}: {
  readonly trail: ReadonlyArray<ProviderHandoffTrailEntry>;
  readonly compact: boolean;
}) {
  const presentation = resolveProviderHandoffTrailPresentation(trail);
  const currentEntry = trail.at(-1);
  if (!currentEntry) return null;

  return (
    <>
      {presentation.first ? (
        <>
          <ProviderStep entry={presentation.first} current={false} showCurrentLabel={false} />
          <TrailConnector isReturn={false} />
          <span
            className="inline-flex h-4 min-w-5 shrink-0 items-center justify-center px-0.5 text-[9px] font-medium tabular-nums text-muted-foreground"
            title={`${presentation.hiddenCount} hidden provider changes`}
          >
            +{presentation.hiddenCount}
          </span>
          <TrailConnector isReturn={presentation.trailing[0]?.isReturn ?? false} />
        </>
      ) : null}
      {presentation.trailing.map((entry, index) => {
        const isCurrent = entry === currentEntry;
        return (
          <React.Fragment key={`${index}:${entry.provider}`}>
            {index > 0 ? <TrailConnector isReturn={entry.isReturn} /> : null}
            <ProviderStep entry={entry} current={isCurrent} showCurrentLabel={!compact} />
          </React.Fragment>
        );
      })}
    </>
  );
}

function TooltipTrail({ trail }: { readonly trail: ReadonlyArray<ProviderHandoffTrailEntry> }) {
  return (
    <div className="max-h-64 max-w-96 overflow-y-auto py-1">
      <div className="font-medium text-foreground">Provider path</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1" dir="ltr">
        {trail.map((entry, index) => (
          <React.Fragment key={`${index}:${entry.provider}`}>
            {index > 0 ? <TrailConnector isReturn={entry.isReturn} /> : null}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-[4px] px-1 py-0.5",
                index === trail.length - 1
                  ? "bg-[var(--color-bg-accent)] text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <ProviderIcon provider={entry.provider} tone="header" className="size-3" />
              {PROVIDER_DISPLAY_NAMES[entry.provider]}
            </span>
          </React.Fragment>
        ))}
      </div>
      <div className="mt-1.5 text-muted-foreground">Context stayed in this conversation.</div>
    </div>
  );
}

export function ProviderHandoffTrail({
  trail,
  compact,
  fallbackLabel,
  fallbackSourceProvider,
  fallbackTargetProvider,
}: {
  readonly trail: ReadonlyArray<ProviderHandoffTrailEntry>;
  readonly compact: boolean;
  readonly fallbackLabel: string | null;
  readonly fallbackSourceProvider: ProviderKind | null;
  readonly fallbackTargetProvider: ProviderKind | null;
}) {
  const continuousTrail = trail.length > 1 ? trail : null;
  const fallbackTrail =
    fallbackLabel && fallbackSourceProvider && fallbackTargetProvider
      ? [
          { provider: fallbackSourceProvider, isReturn: false },
          { provider: fallbackTargetProvider, isReturn: false },
        ]
      : null;
  const displayedTrail = continuousTrail ?? fallbackTrail;
  if (!displayedTrail) return null;
  const currentProvider = displayedTrail.at(-1)?.provider;
  if (!currentProvider) return null;

  const accessibleLabel = continuousTrail
    ? `Provider path. ${describeProviderHandoffTrail(continuousTrail)}. Current provider: ${PROVIDER_DISPLAY_NAMES[currentProvider]}.`
    : (fallbackLabel ?? "Provider handoff");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            tabIndex={0}
            aria-label={accessibleLabel}
            variant="secondary"
            className="hidden !h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[10px] font-normal text-muted-foreground sm:inline-flex"
            dir="ltr"
          >
            <HeaderTrail trail={displayedTrail} compact={compact} />
          </Badge>
        }
      />
      <TooltipPopup side="bottom" className="max-w-96" viewportClassName="px-2.5 py-1.5">
        {continuousTrail ? <TooltipTrail trail={continuousTrail} /> : fallbackLabel}
      </TooltipPopup>
    </Tooltip>
  );
}
