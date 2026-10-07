// The owner's accent for the public page: their Synara theme's accent for the light and the
// dark appearance, falling back to their avatar color, then to the page's default blue.
// Returned as CSS custom properties so the server-rendered page themes itself with no
// client JS; globals.css maps them onto `--info`, which every accent surface reads.

import type { CSSProperties } from "react";
import type { PublicProfile } from "./publicProfile";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export type ProfileAccent = { light: string; dark: string } | null;

/** The owner's light/dark accent, or null to keep the page default. */
export function resolveProfileAccent(
  profile: Pick<PublicProfile, "themeAccent" | "avatarColor">,
): ProfileAccent {
  const theme = profile.themeAccent;
  if (theme && HEX_COLOR.test(theme.light) && HEX_COLOR.test(theme.dark)) {
    return { light: theme.light, dark: theme.dark };
  }
  if (HEX_COLOR.test(profile.avatarColor)) {
    return { light: profile.avatarColor, dark: profile.avatarColor };
  }
  return null;
}

/** Inline style for the page root; empty when the owner has no usable accent. */
export function profileAccentStyle(accent: ProfileAccent): CSSProperties {
  if (!accent) return {};
  return {
    "--profile-accent-light": accent.light,
    "--profile-accent-dark": accent.dark,
  } as CSSProperties;
}
