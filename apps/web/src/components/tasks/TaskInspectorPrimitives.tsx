// FILE: TaskInspectorPrimitives.tsx
// Purpose: Small building blocks the task inspector repeats — the muted section label, the
//          label/value property row, and the notice that says something about a task with
//          an optional action.
// Layer: Tasks UI component
// Exports: TaskSectionLabel, TaskPropertyRow, TaskNotice, TASK_PROPERTY_ICON_CLASS

import type { ComponentProps, ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

/** The leading glyph beside a property value (project folder, due-date calendar). */
export const TASK_PROPERTY_ICON_CLASS = "size-3.5 shrink-0 opacity-70";

/** Muted heading that introduces a block of the inspector ("Agent", "Activity", …). */
export function TaskSectionLabel({ children }: { children: ReactNode }) {
  return <span className="text-ui-sm font-medium text-muted-foreground">{children}</span>;
}

/**
 * One label/value pair of a `<dl>`. `className` and `title` land on the value cell, so the
 * caller owns how its value lays out.
 */
export function TaskPropertyRow({
  label,
  className,
  title,
  children,
}: {
  label: string;
  className?: string | undefined;
  title?: string | undefined;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-ui-sm text-muted-foreground">{label}</dt>
      <dd className={className} title={title}>
        {children}
      </dd>
    </>
  );
}

type TaskNoticeTone = "muted" | "warning" | "failure";

type NoticeActionStyle = Pick<ComponentProps<typeof Button>, "size" | "variant">;

const FRAMED_NOTICE_CLASS = "gap-3 rounded-xl border px-3 py-2.5";
const FRAMED_NOTICE_ACTION: NoticeActionStyle = { size: "xs" };

// A plain line of muted text, or a framed callout (warning, failure) in the foreground ink.
const TASK_NOTICE_TONES: Record<
  TaskNoticeTone,
  { frame: string; text: string; action: NoticeActionStyle }
> = {
  muted: {
    frame: "gap-2",
    text: "text-muted-foreground",
    action: { size: "sm", variant: "outline" },
  },
  warning: {
    frame: cn(FRAMED_NOTICE_CLASS, "border-warning/30 bg-warning/8"),
    text: "text-foreground",
    action: FRAMED_NOTICE_ACTION,
  },
  failure: {
    frame: cn(FRAMED_NOTICE_CLASS, "border-status-failure/25 bg-status-failure/6"),
    text: "text-foreground",
    action: FRAMED_NOTICE_ACTION,
  },
};

/** A sentence about the task's state with, when there is something to do about it, a button. */
export function TaskNotice({
  tone,
  action,
  children,
}: {
  tone?: TaskNoticeTone | undefined;
  action?: { label: string; onClick: () => void } | undefined;
  children: ReactNode;
}) {
  const style = TASK_NOTICE_TONES[tone ?? "muted"];
  return (
    <div className={cn("flex items-center", style.frame)}>
      <p className={cn("flex-1 text-ui-sm", style.text)}>{children}</p>
      {action ? (
        <Button {...style.action} onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
