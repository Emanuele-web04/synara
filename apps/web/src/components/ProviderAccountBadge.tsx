// FILE: ProviderAccountBadge.tsx
// Purpose: How one provider account is drawn wherever accounts sit side by side — the
//   initials pill on a provider icon (model pickers and their triggers) and the avatar
//   tile that carries it (provider settings).
// Layer: Shared presentation
// Depends on: account presentation helpers, provider icons.

import type { ProviderKind } from "@synara/contracts";
import type { CSSProperties } from "react";

import { normalizeProviderAccentColor } from "~/lib/providerInstancePresentation";
import { cn } from "~/lib/utils";

import { ProviderIcon } from "./ProviderIcon";

export function ProviderAccountBadge(props: {
  initials: string;
  /** The account's accent color; the pill stays neutral without a valid one. */
  accentColor?: string | undefined;
  /** Position, plus a `ring-*` color matching the surface the pill is cut out of. */
  className?: string;
}) {
  const accentColor = normalizeProviderAccentColor(props.accentColor);
  return (
    <span
      aria-hidden="true"
      data-accent={accentColor}
      style={accentColor ? { backgroundColor: accentColor } : undefined}
      className={cn(
        // The ring takes the surface color, so the pill reads as cut out of the icon.
        "rounded-[5px] px-[3px] py-px font-semibold text-ui-2xs leading-none tracking-wide ring-2 ring-popover",
        accentColor ? "text-white" : "bg-foreground/85 text-background",
        props.className,
      )}
    >
      {props.initials}
    </span>
  );
}

// Tile that stands for one account in a list: provider icon on a surface washed with the
// account's accent, initials at the corner when the icon alone is ambiguous.
export function ProviderAccountAvatar(props: {
  provider: ProviderKind;
  /** Null while the provider icon alone identifies the account. */
  initials: string | null;
  accentColor?: string | undefined;
  size?: "sm" | "md";
  className?: string;
}) {
  const accentColor = normalizeProviderAccentColor(props.accentColor);
  const size = props.size ?? "sm";
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-lg bg-muted/60 ring-1 ring-border/70",
        accentColor &&
          "bg-[color-mix(in_srgb,var(--account-accent)_14%,transparent)] ring-[color-mix(in_srgb,var(--account-accent)_45%,transparent)]",
        size === "md" ? "size-9" : "size-8",
        props.className,
      )}
      style={accentColor ? ({ "--account-accent": accentColor } as CSSProperties) : undefined}
    >
      <ProviderIcon provider={props.provider} className={size === "md" ? "size-4.5" : "size-4"} />
      {props.initials ? (
        <ProviderAccountBadge
          initials={props.initials}
          accentColor={props.accentColor}
          className="absolute -right-1.5 -bottom-1 ring-background"
        />
      ) : null}
    </span>
  );
}
