// FILE: TaskListEmptyState.tsx
// Purpose: What the task list says when it has no rows to show — the list failed to load,
//          there are no tasks yet, or the active filter hides them all.
// Layer: Tasks UI component
// Exports: TaskListEmptyState

import { Button } from "~/components/ui/button";

export function TaskListEmptyState({
  isLoading,
  isError,
  totalCount,
  visibleCount,
  onRetry,
}: {
  isLoading: boolean;
  isError: boolean;
  /** Every to-do, before the filter. */
  totalCount: number;
  /** The to-dos the active filter lets through. */
  visibleCount: number;
  onRetry: () => void;
}) {
  if (isError && totalCount === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-5 py-16 text-center">
        <p className="text-ui text-foreground">Couldn't load your tasks</p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (!isLoading && !isError && totalCount === 0) {
    return (
      <div className="flex flex-col items-center gap-1 px-5 py-16 text-center">
        <p className="text-ui text-foreground">No tasks yet</p>
        <p className="max-w-sm text-ui-sm text-muted-foreground">
          Add anything you need to do. Select a task and choose Delegate to hand it to an agent in a
          project or folder.
        </p>
      </div>
    );
  }
  if (!isLoading && totalCount > 0 && visibleCount === 0) {
    return <p className="px-5 py-16 text-center text-ui-sm text-muted-foreground">Nothing here.</p>;
  }
  return null;
}
