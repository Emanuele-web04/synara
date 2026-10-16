// FILE: brandIcons.tsx
// Purpose: Simple Icons artwork for third-party brands, shared by the plugin library and
//   the connector catalog.
// Layer: Web UI support
// Exports: BrandArtwork, KNOWN_BRAND_ARTWORK, normalizeBrandKey, readableBrandColor,
//   BRAND_GLYPH_TILE_CLASS_NAME

import type { IconType } from "react-icons";
import {
  SiAtlassian,
  SiCanva,
  SiCloudflare,
  SiFigma,
  SiGithub,
  SiGmail,
  SiGooglecalendar,
  SiGoogledrive,
  SiHuggingface,
  SiLinear,
  SiModelcontextprotocol,
  SiNetlify,
  SiNotion,
  SiPosthog,
  SiPrisma,
  SiRailway,
  SiSentry,
  SiStripe,
  SiSupabase,
  SiTodoist,
  SiVercel,
} from "react-icons/si";

export type BrandArtwork = {
  color: string;
  icon: IconType;
};

// Simple Icons glyph from a raw 24×24 path, for marks react-icons does not ship.
function simpleIconFromPath(path: string): IconType {
  return function SimpleIconPath({ className, style, title }) {
    return (
      <svg
        role="img"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        fill="currentColor"
        className={className}
        style={style}
        aria-hidden={title ? undefined : true}
      >
        {title ? <title>{title}</title> : null}
        <path d={path} />
      </svg>
    );
  };
}

// Missing from react-icons; paths from Simple Icons 16.35 (CC0).
const SiNeon = simpleIconFromPath(
  "M24 0V24l-9.365-8.045V24H0V0ZM2.942 21.087h8.751V9.563l9.365 8.204V2.919L2.942 2.914Z",
);
const SiConvex = simpleIconFromPath(
  "M15.09 18.916c3.488-.387 6.776-2.246 8.586-5.348-.857 7.673-9.247 12.522-16.095 9.545a3.47 3.47 0 0 1-1.547-1.314c-1.539-2.417-2.044-5.492-1.318-8.282 2.077 3.584 6.3 5.78 10.374 5.399m-10.501-7.65c-1.414 3.266-1.475 7.092.258 10.24-6.1-4.59-6.033-14.41-.074-18.953a3.44 3.44 0 0 1 1.893-.707c2.825-.15 5.695.942 7.708 2.977-4.09.04-8.073 2.66-9.785 6.442m11.757-5.437C14.283 2.951 11.053.992 7.515.933c6.84-3.105 15.253 1.929 16.17 9.37a3.6 3.6 0 0 1-.334 2.02c-1.278 2.594-3.647 4.607-6.416 5.352 2.029-3.763 1.778-8.36-.589-11.847",
);

// Slack's mark is four colors, which a single-color Simple Icons path cannot show.
// Paths from Slack's 2019 icon (Wikimedia Commons, Slack_icon_2019.svg).
const SlackColorIcon: IconType = ({ className, style, title }) => (
  <svg
    role="img"
    viewBox="0 0 127 127"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    style={style}
    aria-hidden={title ? undefined : true}
  >
    {title ? <title>{title}</title> : null}
    <path
      fill="#E01E5A"
      d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z"
    />
    <path
      fill="#36C5F0"
      d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z"
    />
    <path
      fill="#2EB67D"
      d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z"
    />
    <path
      fill="#ECB22E"
      d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z"
    />
  </svg>
);

/** Keyed by {@link normalizeBrandKey} of the brand or product name. */
export const KNOWN_BRAND_ARTWORK: Record<string, BrandArtwork> = {
  atlassian: { icon: SiAtlassian, color: "#0052CC" },
  canva: { icon: SiCanva, color: "#00C4CC" },
  cloudflare: { icon: SiCloudflare, color: "#F38020" },
  convex: { icon: SiConvex, color: "#EE342F" },
  figma: { icon: SiFigma, color: "#F24E1E" },
  github: { icon: SiGithub, color: "#181717" },
  gmail: { icon: SiGmail, color: "#EA4335" },
  googlecalendar: { icon: SiGooglecalendar, color: "#4285F4" },
  googledrive: { icon: SiGoogledrive, color: "#0F9D58" },
  huggingface: { icon: SiHuggingface, color: "#FF9D00" },
  linear: { icon: SiLinear, color: "#5E6AD2" },
  modelcontextprotocol: { icon: SiModelcontextprotocol, color: "#111111" },
  neon: { icon: SiNeon, color: "#34D59A" },
  netlify: { icon: SiNetlify, color: "#00C7B7" },
  notion: { icon: SiNotion, color: "#111111" },
  posthog: { icon: SiPosthog, color: "#111111" },
  prisma: { icon: SiPrisma, color: "#2D3748" },
  railway: { icon: SiRailway, color: "#0B0D0E" },
  sentry: { icon: SiSentry, color: "#362D59" },
  slack: { icon: SlackColorIcon, color: "#4A154B" },
  stripe: { icon: SiStripe, color: "#635BFF" },
  supabase: { icon: SiSupabase, color: "#3FCF8E" },
  todoist: { icon: SiTodoist, color: "#E44332" },
  vercel: { icon: SiVercel, color: "#111111" },
};

export function normalizeBrandKey(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/**
 * The brand color, or undefined for near-black marks (Notion, Sentry, ...)
 * that would vanish on a dark tile; callers then inherit the text color.
 */
export function readableBrandColor(hex: string): string | undefined {
  const match = /^#?([0-9a-f]{6})$/iu.exec(hex.trim());
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 16);
  const luminance =
    0.2126 * channel((value >> 16) & 0xff) +
    0.7152 * channel((value >> 8) & 0xff) +
    0.0722 * channel(value & 0xff);
  return luminance < 0.06 ? undefined : hex;
}

/** The bordered square that frames a brand glyph in catalog rows. */
export const BRAND_GLYPH_TILE_CLASS_NAME =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-border/60 bg-background";
