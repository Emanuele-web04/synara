import type {
  ReviewComplexityLevel,
  ReviewFocusAreaSeverity,
  ReviewWalkthroughFocusArea,
} from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";

import { ChartBarIcon, CheckIcon, CircleCheckIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ReviewPill } from "../reviewPrimitives";
import { focusAreaSeverityTone, focusAreaTypeMeta } from "./walkthroughFocusArea";

export const WALKTHROUGH_LIST_ANIMATION = { duration: 150, easing: "ease-out" } as const;

export const WALKTHROUGH_STAGGER_STEP_MS = 24;
export const WALKTHROUGH_STAGGER_CAP = 4;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function SectionHeading(props: { icon: ReactNode; title: string }): ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-border/40 pb-2 text-foreground">
      <span className="text-muted-foreground">{props.icon}</span>
      <h2 className="text-[15px] font-semibold">{props.title}</h2>
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
  const reducedMotion = prefersReducedMotion();
  return (
    <div className="rounded-[0.625rem] border border-border/70 bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ChartBarIcon className="size-3.5" />
          Complexity
        </span>
        <span className="text-[14px] font-semibold text-foreground">
          {COMPLEXITY_LABEL[props.level]}
        </span>
        <span className="flex items-center gap-1" aria-hidden="true">
          {COMPLEXITY_ORDER.map((level, index) => (
            <span key={level} className="h-1.5 w-7 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full w-full origin-left rounded-full bg-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none"
                style={{
                  transform: index < filled ? "scaleX(1)" : "scaleX(0)",
                  transitionDelay: reducedMotion
                    ? "0ms"
                    : `${index * WALKTHROUGH_STAGGER_STEP_MS}ms`,
                }}
              />
            </span>
          ))}
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{props.reasoning}</p>
    </div>
  );
}

export function FocusAreaCard(props: { area: ReviewWalkthroughFocusArea }): ReactElement {
  const meta = focusAreaTypeMeta(props.area.type);
  return (
    <div className="rounded-[0.625rem] border border-border/70 bg-card px-3.5 py-3 transition-[border-color,transform] duration-150 ease-out hover:-translate-y-px hover:border-border motion-reduce:transition-none motion-reduce:hover:translate-y-0">
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
            <span className="min-w-0 break-words text-[14px] font-semibold text-foreground">
              {props.area.title}
            </span>
            <ReviewPill tone={focusAreaSeverityTone(props.area.severity)}>
              {SEVERITY_LABEL[props.area.severity]}
            </ReviewPill>
            <ReviewPill tone="muted">{meta.label}</ReviewPill>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
            {props.area.description}
          </p>
          {props.area.locations.length > 0 ? (
            <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
              {props.area.locations.map((location, index) => (
                <span
                  key={`${index}-${location}`}
                  className="block min-w-0 max-w-[12rem] truncate font-mono text-[11px] text-muted-foreground tabular-nums"
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
        <svg
          viewBox="0 0 14 14"
          className={cn(
            "-rotate-90 size-3.5 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
            complete && "scale-90 opacity-0 delay-150",
          )}
        >
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
            className="stroke-success-foreground transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
          />
        </svg>
        {complete ? (
          <CircleCheckIcon className="absolute size-3.5 text-success-foreground animate-in fade-in duration-150 ease-out delay-150 motion-reduce:animate-none" />
        ) : null}
      </span>
      <span
        role="img"
        aria-label={`${props.viewed} of ${props.total} ${unitLabel} viewed${complete ? ", complete" : ""}`}
        className={cn(
          "transition-colors duration-150 ease-out motion-reduce:transition-none",
          complete && "text-success-foreground",
        )}
      >
        {props.viewed}/{props.total}
      </span>
    </span>
  );
}

export function ViewedToggle(props: { viewed: boolean; onToggle: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-label="Mark file as viewed"
      aria-pressed={props.viewed}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/40 px-2 py-1 text-[11px] text-muted-foreground outline-none transition-[background-color,border-color,transform] duration-150 ease-out hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-3.5 place-items-center rounded-[3px] border transition-[background-color,border-color,color] duration-150 ease-out motion-reduce:transition-none",
          props.viewed
            ? "border-success-foreground bg-success-foreground text-background"
            : "border-border/60",
        )}
      >
        {props.viewed ? (
          <CheckIcon className="size-2.5 animate-in fade-in duration-150 ease-out delay-75 motion-reduce:animate-none" />
        ) : null}
      </span>
      {props.viewed ? "Mark as unviewed" : "Mark as viewed"}
    </button>
  );
}

export { focusAreaSeverityTone, focusAreaTypeMeta };
