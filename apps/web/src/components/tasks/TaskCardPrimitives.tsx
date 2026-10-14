// FILE: TaskCardPrimitives.tsx
// Purpose: The few building blocks the floating task card repeats: the soft "well" that
//          holds an agent's state or the hand-off prompt, the capsule buttons (a soft one and
//          the ink one for the main action), the muted label, and the tone colours a task's
//          status words use.
// Layer: Tasks UI component
// Exports: TaskWell, TaskPillButton, TaskActionButton, TaskCardLabel, TASK_META_TONE_CLASS

import type { ComponentProps, ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type { TaskMetaTone } from "./tasks.logic";

/** Text colour of a task's status word, in the list and on the card. */
export const TASK_META_TONE_CLASS: Record<TaskMetaTone, string> = {
  muted: "text-muted-foreground",
  strong: "text-foreground/80",
  attention: "text-warning",
  review: "text-status-merged",
  failure: "text-status-failure",
};

/** A soft rounded box: the agent's state, the hand-off prompt, an approval to answer. */
export function TaskWell({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-2xl bg-[var(--color-background-button-secondary)] px-3.5 py-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Soft capsule for properties and secondary actions (due day, project, Open chat, Deny). */
export function TaskPillButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      shape="capsule"
      variant="subtle"
      size="xs"
      {...props}
      className={cn(
        "text-ui-sm text-muted-foreground hover:text-foreground sm:text-ui-sm",
        className,
      )}
    />
  );
}

/** The ink capsule for the card's one main action (Start, Allow, Mark as done). */
export function TaskActionButton({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button shape="capsule" size="xs" {...props} className={cn("px-3", className)} />;
}

/** A block's next steps, on one right-aligned row. */
export function TaskActionRow({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-1.5">{children}</div>;
}

/** Muted line that introduces a block of the card. */
export function TaskCardLabel({ children }: { children: ReactNode }) {
  return <span className="text-ui-sm text-muted-foreground">{children}</span>;
}
