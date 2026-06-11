// FILE: LinkChipIcon.tsx
// Purpose: Single source of truth for a link's leading icon — the GitHub mark for
//          GitHub URLs, the site favicon otherwise — using the same describeLinkChip
//          decision the composer link chip uses. Shared by the read-only
//          user-message link chip and markdown links so every link surface parses
//          and renders its icon identically.
// Layer: Shared UI component

import { GitHubIcon } from "~/lib/icons";
import { describeLinkChip } from "~/lib/linkChips";
import { SiteFavicon } from "./SiteFavicon";

export interface LinkChipIconProps {
  /** The link URL the icon represents. */
  readonly url: string;
  /** Square px size for both the GitHub mark and the favicon. Omit to size via `className`. */
  readonly size?: number | undefined;
  readonly className?: string | undefined;
}

export function LinkChipIcon({ url, size, className }: LinkChipIconProps) {
  const { isGitHub } = describeLinkChip(url);
  if (isGitHub) {
    const style = size === undefined ? undefined : { width: `${size}px`, height: `${size}px` };
    return <GitHubIcon aria-hidden="true" className={className} style={style} />;
  }
  return <SiteFavicon url={url} size={size} className={className} />;
}
