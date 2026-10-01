// FILE: ProviderAccountMark.tsx
// Purpose: How one provider account is drawn where accounts sit side by side. Accounts
//   are told apart by their name; an optional accent color adds a dot on the provider
//   icon (model pickers and their triggers) and a wash on the avatar tile (settings).
// Layer: Shared presentation
// Depends on: account presentation helpers, provider icons.

import type { ProviderKind } from "@synara/contracts";
import type { CSSProperties } from "react";

import { normalizeProviderAccentColor } from "~/lib/providerInstancePresentation";
import { cn } from "~/lib/utils";

import { ProviderIcon } from "./ProviderIcon";

/**
 * Dot in the account's accent color. Without an accent it renders nothing, unless
 * `always` asks for a neutral dot (a second account, which must differ from the default).
 */
export function ProviderAccountDot(props: {
  accentColor?: string | undefined;
  always?: boolean;
  /** Position, plus a `ring-*` color matching the surface the dot is cut out of. */
  className?: string;
}) {
  const accentColor = normalizeProviderAccentColor(props.accentColor);
  if (!accentColor && !props.always) return null;
  return (
    <span
      aria-hidden="true"
      data-accent={accentColor}
      style={accentColor ? { backgroundColor: accentColor } : undefined}
      // The ring takes the surface color, so the dot reads as cut out of the icon.
      className={cn(
        "size-2 rounded-full ring-2 ring-popover",
        !accentColor && "bg-muted-foreground",
        props.className,
      )}
    />
  );
}

// Tile that stands for one account in a list: the provider icon on a surface washed
// with the account's accent when it has one.
export function ProviderAccountAvatar(props: {
  provider: ProviderKind;
  accentColor?: string | undefined;
  size?: "sm" | "md";
  className?: string;
}) {
  const accentColor = normalizeProviderAccentColor(props.accentColor);
  const size = props.size ?? "sm";
  return (
    <span
      data-accent={accentColor}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-muted/60 ring-1 ring-border/70",
        accentColor &&
          "bg-[color-mix(in_srgb,var(--account-accent)_14%,transparent)] ring-[color-mix(in_srgb,var(--account-accent)_45%,transparent)]",
        size === "md" ? "size-9" : "size-8",
        props.className,
      )}
      style={accentColor ? ({ "--account-accent": accentColor } as CSSProperties) : undefined}
    >
      <ProviderIcon provider={props.provider} className={size === "md" ? "size-4.5" : "size-4"} />
    </span>
  );
}
