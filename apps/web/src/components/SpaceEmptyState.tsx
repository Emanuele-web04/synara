// one empty-state component for Void and custom Spaces — they each had their own, so the list changed character between tabs

import type { Space } from "~/types";
import { Button } from "./ui/button";

export function SpaceEmptyState(props: {
  /** `null` renders the Void state. */
  space: Space | null;
  /** Whether any project exists outside this Space — i.e. whether there is anything to file. */
  hasProjectsElsewhere: boolean;
  onMoveProjects: () => void;
}) {
  // before the first project exists every Space is empty for the same reason — naming the Space would dress a global "nothing yet" as a per-Space problem
  if (!props.hasProjectsElsewhere) {
    return (
      <p className="px-2 pt-4 text-center text-ui text-muted-foreground/58">No projects yet</p>
    );
  }

  const title = props.space ? `${props.space.name} is empty` : "Void is empty";

  return (
    <div className="px-2 pt-4 pb-1 text-center">
      <p className="text-ui text-foreground/75">{title}</p>
      <p className="mx-auto mt-1 max-w-52 text-ui-xs leading-4 text-muted-foreground/55">
        {props.space
          ? "Move projects here, or right-click a project to file it."
          : "New and unassigned projects appear here."}
      </p>
      {props.space ? (
        <Button size="xs" variant="outline" className="mt-3" onClick={props.onMoveProjects}>
          Move projects here
        </Button>
      ) : null}
    </div>
  );
}
