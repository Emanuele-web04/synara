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

export const WALKTHROUGH_CARD =
  "rounded-[0.625rem] border border-border/70 bg-card px-4 py-3 shadow-[var(--shadow-card)]";

export function SectionHeading(props: { icon: ReactNode; title: string }): ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-border/40 pb-2 text-foreground">
      <span aria-hidden="true" className="text-muted-foreground">
        {props.icon}
      </span>
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
    <div className={WALKTHROUGH_CARD}>
      <div
        className={cn(
          "flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em]",
          props.tone === "success" ? "text-success-foreground" : "text-info-foreground",
        )}
      >
        <span>{props.icon}</span>
        {props.label}
      </div>
      <p className="mt-1.5 text-pretty break-words text-[12px] leading-5 text-muted-foreground">
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

const COMPLEXITY_TONE: Record<ReviewComplexityLevel, { fill: string; text: string }> = {
  low: { fill: "bg-success-foreground", text: "text-success-foreground" },
  medium: { fill: "bg-info-foreground", text: "text-info-foreground" },
  high: { fill: "bg-warning-foreground", text: "text-warning-foreground" },
  "very-high": { fill: "bg-destructive", text: "text-destructive" },
};

export function ComplexityMeter(props: {
  level: ReviewComplexityLevel;
  reasoning: string;
}): ReactElement {
  const filled = COMPLEXITY_ORDER.indexOf(props.level) + 1;
  const tone = COMPLEXITY_TONE[props.level];
  return (
    <div className={WALKTHROUGH_CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          <ChartBarIcon aria-hidden="true" className="size-3.5" />
          Complexity
        </span>
        <span className={cn("text-[14px] font-semibold", tone.text)}>
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
              className={cn("h-1.5 w-7 rounded-full", index < filled ? tone.fill : "bg-border/70")}
            />
          ))}
        </span>
      </div>
      {props.reasoning ? (
        <p className="mt-2 text-pretty text-[12px] leading-5 text-muted-foreground">
          {props.reasoning}
        </p>
      ) : null}
    </div>
  );
}

export function FocusAreaCard(props: { area: ReviewWalkthroughFocusArea }): ReactElement {
  const meta = focusAreaTypeMeta(props.area.type);
  return (
    <div className={WALKTHROUGH_CARD}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          title={meta.label}
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
            meta.iconClassName,
          )}
        >
          <span className="sr-only">{meta.label}</span>
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="w-full min-w-0 text-pretty break-words [overflow-wrap:anywhere] text-[14px] font-semibold text-foreground">
              {props.area.title}
            </span>
            <ReviewPill tone={focusAreaSeverityTone(props.area.severity)}>
              {SEVERITY_LABEL[props.area.severity]}
            </ReviewPill>
          </div>
          {props.area.description ? (
            <p className="mt-1 text-pretty text-[12px] leading-5 text-muted-foreground">
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
    <span
      title={`${props.viewed} of ${props.total} ${unitLabel} viewed`}
      className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground tabular-nums"
    >
      <span aria-hidden="true" className="relative inline-grid size-3.5 place-items-center">
        <svg viewBox="0 0 14 14" className="-rotate-90 size-3.5">
          <circle cx="7" cy="7" r="6" fill="none" strokeWidth="1.5" className="stroke-border" />
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
        <span aria-hidden="true" className="leading-none">
          {props.viewed}/{props.total}
        </span>
        <span className="sr-only" aria-live="polite">
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
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-[0.625rem] border border-border/70 px-2 py-1.5 text-[11px] text-muted-foreground outline-none transition-[background-color,border-color,transform] duration-150 ease-out not-aria-pressed:hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
        props.viewed &&
          "border-success-foreground/40 bg-success/10 text-foreground aria-pressed:hover:bg-success/16",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-3.5 place-items-center rounded-sm border transition-[background-color,border-color,color] duration-150 ease-out motion-reduce:transition-none",
          props.viewed
            ? "border-success-foreground bg-success-foreground text-background"
            : "border-border",
        )}
      >
        <CheckIcon
          className={cn(
            "size-2.5 transition-opacity duration-150 ease-out motion-reduce:transition-none",
            props.viewed ? "opacity-100" : "opacity-0",
          )}
        />
      </span>
      <span className="inline-block min-w-[5.5rem] text-left">
        {props.viewed ? "Viewed" : "Mark as viewed"}
      </span>
    </button>
  );
}

export { focusAreaSeverityTone, focusAreaTypeMeta };
