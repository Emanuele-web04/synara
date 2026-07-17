// FILE: PullRequestActorLabel.tsx
// Purpose: "Who" — the avatar + login pair the pull request surfaces render for an author or a
//          reviewer. It owns the `ghost` fallback GitHub uses for deleted accounts (so one
//          surface can't invent its own word for it) and the truncate + title policy, and it
//          deliberately sets no text size or weight: each host line keeps its own role, so the
//          detail header's author reads emphasized and a reviewer chip stays fine print.
// Layer: Pull request presentation
// Exports: PullRequestActorLabel

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
