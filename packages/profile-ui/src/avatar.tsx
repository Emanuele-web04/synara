// FILE: avatar.tsx
// Purpose: Single source of truth for the profile avatar — renders the user's photo when
// set, otherwise the accent-colored circle with initials. Shared by the Profile header,
// the Edit dialog, the shareable card, and the public profile page so they never drift.
// Layer: profile-ui shared component.

import { cn } from "./cn";

// Picks white or near-black initials text so the avatar keeps readable contrast
// against whichever accent color the user picked (palette includes light colors
// like emerald and amber where white fails WCAG).
function avatarForeground(color: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(color.trim());
  if (!match) return "#ffffff";
  const hex = match[1]!;
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.28 ? "#1f2937" : "#ffffff";
}

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
      className={cn("flex items-center justify-center overflow-hidden rounded-full", className)}
      style={image ? undefined : { backgroundColor: color, color: avatarForeground(color) }}
    >
      {image ? (
        <img src={image} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className={cn("font-semibold tracking-tight", textClassName)}>{initials}</span>
      )}
    </div>
  );
}
