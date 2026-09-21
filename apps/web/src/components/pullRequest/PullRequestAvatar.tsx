import { useState } from "react";

import type { PullRequestActor } from "@synara/contracts";

import { cn } from "~/lib/utils";

const SIZE_CLASS_NAME = {
  sm: "size-4 text-[8px]",
  md: "size-5 text-ui-2xs",
  lg: "size-7 text-ui-sm",
} as const;

function initialFor(actor: PullRequestActor | null): string {
  const source = actor?.name?.trim() || actor?.login?.trim();
  return source ? source.slice(0, 1).toUpperCase() : "?";
}

export function PullRequestAvatar({
  actor,
  size: sizeProp,
  className,
}: {
  actor: PullRequestActor | null;
  size?: keyof typeof SIZE_CLASS_NAME;
  className?: string;
}) {
  const size = sizeProp ?? "sm";
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const sizeClassName = SIZE_CLASS_NAME[size];
  // only render an image URL GitHub explicitly attached — `login` can be a team slug and deriving avatars.githubusercontent.com/<slug> can display an unrelated user
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
