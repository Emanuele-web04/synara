// FILE: ProfileAvatar.tsx
// Purpose: Single source of truth for the profile avatar — renders the user's photo when
// set, otherwise the accent-colored circle with initials. Shared by the Profile header,
// the Edit dialog, and the shareable card so the three never drift.
// Layer: web profile feature.

import { cn } from "~/lib/utils";

interface ProfileAvatarProps {
  readonly initials: string;
  readonly color: string;
  readonly image?: string | null;
  /** Sizing/shape utility classes for the circle, e.g. "size-16". */
  readonly className?: string;
  /** Type scale for the initials fallback, e.g. "text-xl". */
  readonly textClassName?: string;
}

export function ProfileAvatar({
  initials,
  color,
  image,
  className,
  textClassName,
}: ProfileAvatarProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-center overflow-hidden rounded-full text-white",
        className,
      )}
      style={image ? undefined : { backgroundColor: color }}
    >
      {image ? (
        <img src={image} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className={cn("font-semibold tracking-tight", textClassName)}>{initials}</span>
      )}
    </div>
  );
}
