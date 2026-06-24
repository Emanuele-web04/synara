import type {
  ReviewComplexityLevel,
  ReviewFocusAreaSeverity,
  ReviewFocusAreaType,
  ReviewWalkthroughFocusArea,
} from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";

import {
  ChartBarIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  GitPullRequestIcon,
  InfoIcon,
  LockIcon,
  TriangleAlertIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ReviewPill, type ReviewPillTone } from "../reviewPrimitives";

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
            <span
              key={level}
              className={cn(
                "h-1.5 w-7 rounded-full transition-colors duration-200 motion-reduce:transition-none",
                index < filled ? "bg-muted-foreground" : "bg-muted",
              )}
            />
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
            <span className="text-[14px] font-semibold text-foreground">{props.area.title}</span>
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
                  className="block min-w-0 max-w-full truncate font-mono text-[11px] text-muted-foreground tabular-nums"
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
}): ReactElement {
  const unit = props.unit ?? "files";
  const complete = props.total > 0 && props.viewed >= props.total;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground tabular-nums">
      {complete ? (
        <CircleCheckIcon className="size-3.5 text-success-foreground" />
      ) : (
        <span
          aria-hidden="true"
          className="inline-block size-3.5 rounded-full border-[1.5px] border-muted-foreground/70"
        />
      )}
      <span
        role="img"
        aria-label={`${props.viewed} of ${props.total} ${unit} viewed${complete ? ", complete" : ""}`}
      >
        <span aria-hidden="true" className={cn(complete && "text-success-foreground")}>
          {props.viewed}/{props.total}
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
      aria-label="Mark file as viewed"
      aria-pressed={props.viewed}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/40 px-2 py-1 text-[11px] text-muted-foreground outline-none transition-[background-color,border-color] duration-150 hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-3.5 place-items-center rounded-[3px] border",
          props.viewed
            ? "border-success-foreground bg-success-foreground text-background"
            : "border-border/60",
        )}
      >
        {props.viewed ? <CheckIcon className="size-2.5" /> : null}
      </span>
      {props.viewed ? "Mark as unviewed" : "Mark as viewed"}
    </button>
  );
}

export function focusAreaSeverityTone(severity: ReviewFocusAreaSeverity): ReviewPillTone {
  switch (severity) {
    case "critical":
      return "danger";
    case "high":
      return "warning";
    case "medium":
      return "info";
    case "info":
      return "muted";
  }
}

export function focusAreaTypeMeta(type: ReviewFocusAreaType): {
  label: string;
  icon: ReactNode;
  iconClassName: string;
} {
  switch (type) {
    case "security":
      return {
        label: "Security",
        icon: <LockIcon className="size-3.5" />,
        iconClassName: "bg-destructive/12 text-destructive",
      };
    case "performance":
      return {
        label: "Performance",
        icon: <ClockIcon className="size-3.5" />,
        iconClassName: "bg-info/12 text-info-foreground",
      };
    case "data-integrity":
      return {
        label: "Data integrity",
        icon: <TriangleAlertIcon className="size-3.5" />,
        iconClassName: "bg-warning/12 text-warning-foreground",
      };
    case "architecture":
      return {
        label: "Architecture",
        icon: <GitPullRequestIcon className="size-3.5" />,
        iconClassName: "bg-muted text-muted-foreground",
      };
    case "testing-gap":
      return {
        label: "Testing gap",
        icon: <CircleAlertIcon className="size-3.5" />,
        iconClassName: "bg-info/12 text-info-foreground",
      };
    case "breaking-change":
      return {
        label: "Breaking change",
        icon: <TriangleAlertIcon className="size-3.5" />,
        iconClassName: "bg-destructive/12 text-destructive",
      };
    case "high-complexity":
      return {
        label: "High complexity",
        icon: <ChartBarIcon className="size-3.5" />,
        iconClassName: "bg-warning/12 text-warning-foreground",
      };
    case "new-pattern":
      return {
        label: "New pattern",
        icon: <InfoIcon className="size-3.5" />,
        iconClassName: "bg-muted text-muted-foreground",
      };
    default:
      return {
        label: type,
        icon: <InfoIcon className="size-3.5" />,
        iconClassName: "bg-muted text-muted-foreground",
      };
  }
}
