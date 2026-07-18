import { IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useCompanion } from "../companionContext";
import { EmptyState, ScreenHeader, ThreadRow } from "../components/ui";
import type { ThreadStatus } from "../domain";
import { sortThreads } from "../lib/mobileLogic";

const filters: ReadonlyArray<{ readonly value: "all" | ThreadStatus; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "waiting-approval", label: "Approval" },
  { value: "waiting-input", label: "Input" },
  { value: "completed", label: "Completed" },
];

export function TasksScreen() {
  const { shell } = useCompanion();
  const [filter, setFilter] = useState<(typeof filters)[number]["value"]>("all");
  const threads = useMemo(
    () =>
      sortThreads(shell.threads).filter((thread) => filter === "all" || thread.status === filter),
    [filter, shell.threads],
  );

  return (
    <div className="screen">
      <ScreenHeader eyebrow="All projects" title="Tasks" />
      <div className="filter-strip" role="group" aria-label="Filter tasks">
        {filters.map((item) => (
          <button
            type="button"
            key={item.value}
            className="filter-chip"
            data-active={item.value === filter || undefined}
            aria-pressed={item.value === filter}
            onClick={() => setFilter(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {threads.length > 0 ? (
        <div className="thread-list">
          {threads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconSearch size={23} />}
          title="No tasks in this view"
          description="Choose another status to see the rest of your work."
        />
      )}
    </div>
  );
}
