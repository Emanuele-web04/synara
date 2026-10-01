// FILE: ProviderAccountBadge.tsx
// Purpose: Initials pill that tells accounts of one provider apart wherever the provider
//   icon is shown (model pickers, their triggers, provider settings).
// Layer: Shared presentation
// Depends on: account presentation helpers.

import { normalizeProviderAccentColor } from "~/lib/providerInstancePresentation";
import { cn } from "~/lib/utils";

export function ProviderAccountBadge(props: {
  initials: string;
  /** The account's accent color; the pill stays neutral without a valid one. */
  accentColor?: string | undefined;
  className?: string;
}) {
  const accentColor = normalizeProviderAccentColor(props.accentColor);
  return (
    <span
      aria-hidden="true"
      data-accent={accentColor}
      style={accentColor ? { backgroundColor: accentColor } : undefined}
      className={cn(
        "rounded-sm px-0.5 font-medium text-ui-2xs leading-none ring-1 ring-border",
        accentColor ? "text-white" : "bg-popover text-foreground",
        props.className,
      )}
    >
      {props.initials}
    </span>
  );
}
