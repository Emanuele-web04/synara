import type {
  ReviewComplexityLevel,
  ReviewFocusAreaSeverity,
  ReviewWalkthroughFocusArea,
} from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";

import { ChartBarIcon, CheckIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ReviewPill } from "../reviewPrimitives";
import { focusAreaSeverityTone, focusAreaTypeMeta } from "./walkthroughFocusArea";

export function SectionHeading(props: { icon: ReactNode; title: string }): ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-border/40 pb-2 text-foreground">
      <span className="text-muted-foreground">{props.icon}</span>
      <h3 className="text-[15px] font-semibold">{props.title}</h3>
    </div>
  );
}

export function ProseCard(props: {
  icon: ReactNode;
  label: string;
  tone: "info" | "success";
  children: ReactNode;
}): ReactElement {
  return (
    <div className="rounded-[0.625rem] border border-border/70 bg-card px-4 py-3.5">
      <div
        className={cn(
          "flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide",
          props.tone === "success" ? "text-success-foreground" : "text-info-foreground",
        )}
      >
        <span>{props.icon}</span>
        {props.label}
      </div>
      <p className="mt-1.5 break-words text-[12px] leading-5 text-muted-foreground">
        {props.children}
      </p>
    </div>
  );
}

const COMPLEXITY_ORDER: readonly ReviewComplexityLevel[] = ["low", "medium", "high", "very-high"];

const COMPLEXITY_LABEL: Record<ReviewComplexityLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  "very-high": "Very high",
};

const SEVERITY_LABEL: Record<ReviewFocusAreaSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  info: "Info",
};

export function ComplexityMeter(props: {
  level: ReviewComplexityLevel;
  reasoning: string;
}): ReactElement {
  const filled = COMPLEXITY_ORDER.indexOf(props.level) + 1;
  return (
    <div className="rounded-[0.625rem] border border-border/70 bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ChartBarIcon className="size-3.5" />
          Complexity
        </span>
        <span className="text-[14px] font-semibold text-foreground">
          {COMPLEXITY_LABEL[props.level]}
          <span className="sr-only">
            {" "}
            (level {filled} of {COMPLEXITY_ORDER.length})
          </span>
        </span>
        <span className="flex items-center gap-1" aria-hidden="true">
          {COMPLEXITY_ORDER.map((level, index) => (
            <span
              key={level}
              className={cn(
                "h-1.5 w-7 rounded-full",
                index < filled ? "bg-muted-foreground" : "bg-muted",
              )}
            />
          ))}
        </span>
      </div>
      {props.reasoning ? (
        <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{props.reasoning}</p>
      ) : null}
    </div>
  );
}

export function FocusAreaCard(props: { area: ReviewWalkthroughFocusArea }): ReactElement {
  const meta = focusAreaTypeMeta(props.area.type);
  return (
    <div className="rounded-[0.625rem] border border-border/70 bg-card px-3.5 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
            meta.iconClassName,
          )}
        >
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="w-full min-w-0 break-words [overflow-wrap:anywhere] text-[14px] font-semibold text-foreground">
              {props.area.title}
            </span>
            <ReviewPill tone={focusAreaSeverityTone(props.area.severity)}>
              {SEVERITY_LABEL[props.area.severity]}
            </ReviewPill>
            <ReviewPill tone="muted">{meta.label}</ReviewPill>
          </div>
          {props.area.description ? (
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              {props.area.description}
            </p>
          ) : null}
          {props.area.locations.length > 0 ? (
            <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
              {props.area.locations.map((location) => (
                <span
                  key={location}
                  title={location}
                  className="block min-w-0 max-w-full basis-full truncate font-mono text-[11px] text-muted-foreground"
                >
                  {location}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ProgressRing(props: {
  viewed: number;
  total: number;
  unit?: string;
}): ReactElement | null {
  const unit = props.unit ?? "files";
  if (props.total === 0) {
    return null;
  }
  const unitLabel = props.total === 1 ? unit.replace(/s$/, "") : unit;
  const complete = props.viewed >= props.total;
  const progress = Math.min(props.viewed / props.total, 1);
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground tabular-nums">
      <span aria-hidden="true" className="relative inline-grid size-3.5 place-items-center">
        <svg viewBox="0 0 14 14" className="-rotate-90 size-3.5">
          <circle cx="7" cy="7" r="6" fill="none" strokeWidth="1.5" className="stroke-muted" />
          <circle
            cx="7"
            cy="7"
            r="6"
            fill="none"
            strokeWidth="1.5"
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - progress}
            className="stroke-success-foreground transition-[stroke-dashoffset] duration-200 ease-out motion-reduce:transition-none"
          />
        </svg>
      </span>
      <span
        className={cn(
          "transition-colors duration-150 ease-out motion-reduce:transition-none",
          complete && "text-success-foreground",
        )}
      >
        <span aria-hidden="true">
          {props.viewed}/{props.total}
        </span>
        <span className="sr-only">
          {props.viewed} of {props.total} {unitLabel} viewed{complete ? ", complete" : ""}
        </span>
      </span>
    </span>
  );
}

export function ViewedToggle(props: { viewed: boolean; onToggle: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-pressed={props.viewed}
      className="flex shrink-0 items-center gap-1.5 rounded-[0.625rem] border border-border/40 px-2 py-1 text-[11px] text-muted-foreground outline-none transition-[background-color,border-color,transform] duration-150 ease-out hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-3.5 place-items-center rounded-[3px] border transition-[background-color,border-color,color] duration-150 ease-out motion-reduce:transition-none",
          props.viewed
            ? "border-success-foreground bg-success-foreground text-background"
            : "border-border/40",
        )}
      >
        <CheckIcon
          className={cn(
            "size-2.5 transition-opacity duration-150 ease-out motion-reduce:transition-none",
            props.viewed ? "opacity-100" : "opacity-0",
          )}
        />
      </span>
      {props.viewed ? "Mark as unviewed" : "Mark as viewed"}
    </button>
  );
}

export { focusAreaSeverityTone, focusAreaTypeMeta };
