// FILE: PullRequestActorLabel.tsx
// Purpose: "Who" — the avatar + name pair every GitHub item surface renders for a person (list
//          rows, detail header, reviewers, assignees, comments). It owns the `ghost` fallback
//          GitHub uses for deleted accounts (so one surface can't invent its own word for it) and
//          the truncate + title policy (login in the tooltip), and it
//          deliberately sets no text size or weight: each host line keeps its own role, so the
//          detail header's author reads emphasized and a reviewer chip stays fine print.
// Layer: Pull request presentation
// Exports: PullRequestActorLabel

import type { PullRequestActor } from "@synara/contracts";

import { cn } from "~/lib/utils";
import { PullRequestAvatar } from "./PullRequestAvatar";
import { githubActorName } from "./pullRequestDetail.logic";

export function PullRequestActorLabel({
  actor,
  className,
}: {
  actor: PullRequestActor | null;
  className?: string;
}) {
  // GitHub attributes work from a deleted account to "ghost"; say the same word everywhere.
  // The display name leads, as in the list rows; the login stays in the tooltip.
  const login = actor?.login ?? "ghost";
  const name = githubActorName(actor) ?? login;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)} title={login}>
      <PullRequestAvatar actor={actor} size="sm" />
      <span className="truncate">{name}</span>
    </span>
  );
}
