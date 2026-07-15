// FILE: PullRequestAvatar.tsx
// Purpose: Small circular author avatar shared by the pull request list rows, detail header,
//          reviewers row, and comment cards — an image when GitHub gives us one, otherwise an
//          initials fallback so every actor still reads as a person rather than a blank slot.
// Layer: Pull request presentation
// Exports: PullRequestAvatar

import { useState } from "react";

import type { PullRequestActor } from "@synara/contracts";

import { cn } from "~/lib/utils";

const SIZE_CLASS_NAME = {
  sm: "size-4 text-[8px]",
  md: "size-5 text-[9px]",
  lg: "size-7 text-[length:var(--app-font-size-ui-sm,11px)]",
} as const;

function initialFor(actor: PullRequestActor | null): string {
  const source = actor?.name?.trim() || actor?.login?.trim();
  return source ? source.slice(0, 1).toUpperCase() : "?";
}

export function PullRequestAvatar({
  actor,
  size = "sm",
  className,
}: {
  actor: PullRequestActor | null;
  size?: keyof typeof SIZE_CLASS_NAME;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const sizeClassName = SIZE_CLASS_NAME[size];
  // Only render an image URL that GitHub explicitly attached to this actor. `login` can also
  // carry a team slug, and deriving avatars.githubusercontent.com/<slug> on the client can
  // display an unrelated user who happens to own that login.
  const src = actor?.avatarUrl;
  if (src && src !== failedSrc) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailedSrc(src)}
        className={cn(
          sizeClassName,
          "shrink-0 rounded-full object-cover ring-1 ring-border/50",
          className,
        )}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        sizeClassName,
        "flex shrink-0 items-center justify-center rounded-full bg-[var(--color-background-elevated-secondary)] font-medium text-muted-foreground ring-1 ring-border/50",
        className,
      )}
    >
      {initialFor(actor)}
    </span>
  );
}
