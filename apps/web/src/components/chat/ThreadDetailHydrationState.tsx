// FILE: ThreadDetailHydrationState.tsx
// Purpose: Render the transcript placeholder while thread history syncs (or after it fails).
// Layer: Chat presentation
// Depends on: shared Spinner and Button primitives.

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

export const ThreadDetailHydrationState = function ThreadDetailHydrationState({
  state,
  onRetry,
}: {
  state: "loading" | "failed";
  onRetry: () => void;
}) {
  if (state === "loading") {
    return (
      <div className="flex flex-col items-center gap-3 select-none">
        <Spinner aria-label="Loading conversation" className="size-5 text-muted-foreground/50" />
        <span className="text-sm text-muted-foreground/50">Loading conversation</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <span className="text-sm text-muted-foreground">This conversation didn't load.</span>
      <Button onClick={onRetry} size="sm" variant="outline">
        Try again
      </Button>
    </div>
  );
};
