import type { ReviewFocusAreaSeverity, ReviewFocusAreaType } from "@t3tools/contracts";
import type { ReactNode } from "react";

import {
  ChartBarIcon,
  CircleAlertIcon,
  ClockIcon,
  GitPullRequestIcon,
  InfoIcon,
  LockIcon,
  TriangleAlertIcon,
} from "~/lib/icons";
import type { ReviewPillTone } from "../reviewPrimitives";

const FOCUS_AREA_SEVERITY_TONE: Record<ReviewFocusAreaSeverity, ReviewPillTone> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  info: "muted",
};

export function focusAreaSeverityTone(severity: ReviewFocusAreaSeverity): ReviewPillTone {
  return FOCUS_AREA_SEVERITY_TONE[severity];
}

export type FocusAreaTypeMeta = { label: string; icon: ReactNode; iconClassName: string };

const FOCUS_AREA_TYPE_META: Record<ReviewFocusAreaType, FocusAreaTypeMeta> = {
  security: {
    label: "Security",
    icon: <LockIcon className="size-3.5" />,
    iconClassName: "bg-destructive/12 text-destructive",
  },
  performance: {
    label: "Performance",
    icon: <ClockIcon className="size-3.5" />,
    iconClassName: "bg-info/12 text-info-foreground",
  },
  "data-integrity": {
    label: "Data integrity",
    icon: <TriangleAlertIcon className="size-3.5" />,
    iconClassName: "bg-warning/12 text-warning-foreground",
  },
  architecture: {
    label: "Architecture",
    icon: <GitPullRequestIcon className="size-3.5" />,
    iconClassName: "bg-muted-foreground/12 text-muted-foreground",
  },
  "testing-gap": {
    label: "Testing gap",
    icon: <CircleAlertIcon className="size-3.5" />,
    iconClassName: "bg-info/12 text-info-foreground",
  },
  "breaking-change": {
    label: "Breaking change",
    icon: <TriangleAlertIcon className="size-3.5" />,
    iconClassName: "bg-destructive/12 text-destructive",
  },
  "high-complexity": {
    label: "High complexity",
    icon: <ChartBarIcon className="size-3.5" />,
    iconClassName: "bg-warning/12 text-warning-foreground",
  },
  "new-pattern": {
    label: "New pattern",
    icon: <InfoIcon className="size-3.5" />,
    iconClassName: "bg-muted-foreground/12 text-muted-foreground",
  },
};

export function focusAreaTypeMeta(type: ReviewFocusAreaType): FocusAreaTypeMeta {
  return (
    FOCUS_AREA_TYPE_META[type] ?? {
      label: type,
      icon: <InfoIcon className="size-3.5" />,
      iconClassName: "bg-muted/40 text-muted-foreground",
    }
  );
}
