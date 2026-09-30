// FILE: TaskListSections.tsx
// Purpose: The grouped body of the task list: one headed section per kind of open work
//          (Needs you, Running, To do), then Completed folded behind a disclosure.
// Layer: Tasks UI component
// Exports: TaskListSections

import type { ReactNode } from "react";

import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { cn } from "~/lib/utils";
import { TaskStatusGlyph } from "./TaskGlyphs";
import { TASK_LIST_INSET_CLASS } from "./taskListStyles";
import type { TaskRowModel, TaskSection, TaskSectionKey, TaskStatusKind } from "./tasks.logic";

const SECTION_GLYPH: Record<TaskSectionKey, TaskStatusKind> = {
  needs: "needs",
  running: "running",
  todo: "todo",
};

const SECTION_HEADER_CLASS = cn(
  "flex h-8.5 items-center gap-2.5 border-b border-border bg-muted/40 px-5",
  TASK_LIST_INSET_CLASS,
);

export function TaskListSections({
  sections,
  completed,
  completedExpanded,
  onToggleCompleted,
  renderRow,
}: {
  sections: readonly TaskSection[];
  completed: readonly TaskRowModel[];
  completedExpanded: boolean;
  onToggleCompleted: () => void;
  /** Renders one row; it supplies the row's key. */
  renderRow: (row: TaskRowModel) => ReactNode;
}) {
  return (
    <div>
      {sections.map((section) => (
        <section key={section.key} aria-label={section.label}>
          <div className={SECTION_HEADER_CLASS}>
            <TaskStatusGlyph kind={SECTION_GLYPH[section.key]} animated={false} />
            <h3 className="text-ui-sm font-medium text-foreground">{section.label}</h3>
            <span className="text-ui-sm text-muted-foreground">{section.rows.length}</span>
          </div>
          <div role="list" aria-label={section.label}>
            {section.rows.map(renderRow)}
          </div>
        </section>
      ))}

      {completed.length > 0 ? (
        <section aria-label="Completed">
          <button
            type="button"
            aria-expanded={completedExpanded}
            onClick={onToggleCompleted}
            className={cn(SECTION_HEADER_CLASS, "w-full text-left")}
          >
            <TaskStatusGlyph kind="done" />
            <span className="text-ui-sm font-medium text-foreground">Completed</span>
            <span className="text-ui-sm text-muted-foreground">{completed.length}</span>
            <DisclosureChevron open={completedExpanded} className="size-3 text-muted-foreground" />
          </button>
          <DisclosureRegion open={completedExpanded}>
            <div role="list" aria-label="Completed">
              {completed.map(renderRow)}
            </div>
          </DisclosureRegion>
        </section>
      ) : null}
    </div>
  );
}
