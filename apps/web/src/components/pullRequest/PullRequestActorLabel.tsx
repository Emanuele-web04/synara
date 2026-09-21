import type { PullRequestActor } from "@synara/contracts";

import { cn } from "~/lib/utils";
import { PullRequestAvatar } from "./PullRequestAvatar";

export function PullRequestActorLabel({
  actor,
  className,
}: {
  actor: PullRequestActor | null;
  className?: string;
}) {
  // GitHub attributes work from a deleted account to "ghost"; say the same word everywhere.
  const login = actor?.login ?? "ghost";
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)} title={login}>
      <PullRequestAvatar actor={actor} size="sm" />
      <span className="truncate">{login}</span>
    </span>
  );
}
