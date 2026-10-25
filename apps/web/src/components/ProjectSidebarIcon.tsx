// FILE: ProjectSidebarIcon.tsx
// Purpose: Render a project's glyph: its chosen emoji or icon, its local favicon (logo), or the
//          standard folder, which opens and closes with the project row.
// Layer: Sidebar UI component
// Exports: ProjectSidebarIcon, ProjectEmojiGlyph, ProjectDisclosureChevron

import { useEffect, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import { CentralIcon } from "~/lib/central-icons";
import {
  DEFAULT_PROJECT_ICON,
  projectColorValue,
  type ProjectAppearance,
  type ProjectColor,
} from "~/lib/projectAppearance";
import { cn } from "~/lib/utils";
import { resolveExecutionResource } from "~/lib/wsHttpUrl";
import { FolderIcon, FolderOpenIcon } from "~/lib/icons";
import { DisclosureChevron } from "./ui/DisclosureChevron";

// Whether each favicon URL loads, shared so every glyph of a project (row, rail, hover card, …)
// switches together, and a logo that fails to display falls back everywhere at once.
const faviconLoads = new Map<string, boolean>();
const faviconProbes = new Set<string>();
const faviconListeners = new Set<() => void>();

function subscribeToFaviconLoads(listener: () => void) {
  faviconListeners.add(listener);
  return () => {
    faviconListeners.delete(listener);
  };
}

function recordFaviconLoad(src: string, loads: boolean) {
  if (faviconLoads.get(src) === loads) return;
  faviconLoads.set(src, loads);
  for (const listener of faviconListeners) listener();
}

/** The project's favicon URL once it has loaded; null while probing or when there is none. */
function useProjectFavicon(cwd: string): string | null {
  const src = resolveExecutionResource({ kind: "project-favicon", cwd });
  const loads = useSyncExternalStore(subscribeToFaviconLoads, () => faviconLoads.get(src) === true);

  // Probe with Image() so Electron/file-origin behaves like the visible <img>. Probing again on
  // each mount is cheap (the server's answer is cached for an hour) and picks up a favicon
  // added or removed after that.
  useEffect(() => {
    if (faviconProbes.has(src)) return;
    faviconProbes.add(src);
    const image = new Image();
    const settle = (loaded: boolean) => {
      faviconProbes.delete(src);
      recordFaviconLoad(src, loaded);
    };
    image.addEventListener("load", () => settle(true));
    image.addEventListener("error", () => settle(false));
    image.src = src;
  }, [src]);

  return loads ? src : null;
}

function colorStyle(color: ProjectColor | null): CSSProperties | undefined {
  return color ? { color: projectColorValue(color) } : undefined;
}

// A hairline halo in the text color keeps a black logo visible on the dark theme and a white
// one on the light theme; it barely shows on logos that already contrast.
const LOGO_HALO_CLASS_NAME =
  "drop-shadow-[0_0_1px_color-mix(in_srgb,var(--foreground)_60%,transparent)]";

/**
 * An emoji drawn as SVG text, so it scales with the same `size-*` box as the line icons
 * instead of following the UI font size.
 */
export function ProjectEmojiGlyph({ emoji, className }: { emoji: string; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={cn("shrink-0 overflow-visible", className)}>
      <text x="10" y="10.5" dominantBaseline="central" textAnchor="middle" fontSize="19">
        {emoji}
      </text>
    </svg>
  );
}

type ProjectGlyphProps = {
  cwd: string;
  expanded: boolean;
  appearance?: ProjectAppearance | null | undefined;
};

/** An emoji, icon, or folder color chosen in Edit project wins over the detected favicon. */
export function ProjectSidebarIcon({
  cwd,
  expanded,
  appearance,
  glyphClassName = "size-4",
}: ProjectGlyphProps & { glyphClassName?: string }) {
  if (appearance?.kind === "emoji") {
    return <ProjectEmojiGlyph emoji={appearance.emoji} className={glyphClassName} />;
  }
  if (appearance?.kind === "icon" && appearance.icon !== DEFAULT_PROJECT_ICON) {
    return (
      <CentralIcon
        name={appearance.icon}
        className={glyphClassName}
        style={colorStyle(appearance.color)}
      />
    );
  }
  const FolderGlyph = expanded ? FolderOpenIcon : FolderIcon;
  const folder = (
    <FolderGlyph className={glyphClassName} style={colorStyle(appearance?.color ?? null)} />
  );
  return appearance?.color ? (
    folder
  ) : (
    <ProjectLogo cwd={cwd} className={glyphClassName} fallback={folder} />
  );
}

function ProjectLogo({
  cwd,
  className,
  fallback,
}: {
  cwd: string;
  className: string;
  fallback: ReactNode;
}) {
  const favicon = useProjectFavicon(cwd);
  if (!favicon) return fallback;
  return (
    <img
      src={favicon}
      alt=""
      aria-hidden="true"
      className={cn(className, "rounded-[2px] object-contain", LOGO_HALO_CLASS_NAME)}
      onError={() => recordFaviconLoad(favicon, false)}
    />
  );
}

/**
 * The open/closed chevron for a project row whose glyph cannot show that state: an emoji, an
 * icon, or a logo. The folder already opens and closes with the row.
 */
export function ProjectDisclosureChevron({
  cwd,
  expanded,
  appearance,
  className,
}: ProjectGlyphProps & { className?: string }) {
  if (
    appearance?.kind === "emoji" ||
    (appearance?.kind === "icon" && appearance.icon !== DEFAULT_PROJECT_ICON)
  ) {
    return <DisclosureChevron open={expanded} className={className} />;
  }
  if (appearance?.color) return null;
  return <LogoDisclosureChevron cwd={cwd} expanded={expanded} className={className} />;
}

function LogoDisclosureChevron({
  cwd,
  expanded,
  className,
}: {
  cwd: string;
  expanded: boolean;
  className: string | undefined;
}) {
  return useProjectFavicon(cwd) ? (
    <DisclosureChevron open={expanded} className={className} />
  ) : null;
}
