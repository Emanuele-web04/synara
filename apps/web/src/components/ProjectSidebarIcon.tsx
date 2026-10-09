// FILE: ProjectSidebarIcon.tsx
// Purpose: Render a project's glyph: its chosen emoji or icon, or the standard folder with an
//          optional favicon badge overlay or a primary favicon in compact rows.
// Layer: Sidebar UI component
// Exports: ProjectSidebarIcon, ProjectEmojiGlyph

import { useEffect, useState, type CSSProperties } from "react";

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

const projectFaviconPresence = new Map<string, boolean>();

function resolveProjectFaviconUrl(cwd: string): string {
  return resolveExecutionResource({ kind: "project-favicon", cwd });
}

function colorStyle(color: ProjectColor | null): CSSProperties | undefined {
  return color ? { color: projectColorValue(color) } : undefined;
}

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

export function ProjectSidebarIcon({
  cwd,
  expanded,
  appearance,
  glyphClassName: glyphClassNameProp,
  presentation = "badge",
}: {
  cwd: string;
  expanded: boolean;
  appearance?: ProjectAppearance | null | undefined;
  glyphClassName?: string;
  presentation?: "badge" | "favicon";
}) {
  const glyphClassName = glyphClassNameProp ?? "size-4";
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
  if (presentation === "favicon" && appearance?.kind === "icon" && appearance.color) {
    const FolderGlyph = expanded ? FolderOpenIcon : FolderIcon;
    return <FolderGlyph className={glyphClassName} style={colorStyle(appearance.color)} />;
  }
  return (
    <ProjectFolderIcon
      cwd={cwd}
      expanded={expanded}
      color={appearance?.color ?? null}
      glyphClassName={glyphClassName}
      presentation={presentation}
    />
  );
}

function ProjectFolderIcon({
  cwd,
  expanded,
  color,
  glyphClassName,
  presentation,
}: {
  cwd: string;
  expanded: boolean;
  color: ProjectColor | null;
  glyphClassName: string;
  presentation: "badge" | "favicon";
}) {
  const faviconSrc = resolveProjectFaviconUrl(cwd);
  // Keyed by src: a cwd change derives back to the cache-seeded default in the
  // same render, so the probe effect never needs a synchronous setState.
  const [probe, setProbe] = useState<{ src: string; present: boolean } | null>(() => {
    const cached = projectFaviconPresence.get(faviconSrc);
    return cached === undefined ? null : { src: faviconSrc, present: cached };
  });
  const hasFavicon = probe !== null && probe.src === faviconSrc && probe.present;
  const FolderGlyph = expanded ? FolderOpenIcon : FolderIcon;

  // Probe with Image() so Electron/file-origin behaves like the actual visible
  // <img>. Runs even on a module-cache hit (the browser cache makes the reload
  // instant) so the load/error handlers stay the only state writers.
  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    const handleLoad = () => {
      projectFaviconPresence.set(faviconSrc, true);
      if (!cancelled) {
        setProbe({ src: faviconSrc, present: true });
      }
    };
    const handleError = () => {
      projectFaviconPresence.set(faviconSrc, false);
      if (!cancelled) {
        setProbe({ src: faviconSrc, present: false });
      }
    };

    image.addEventListener("load", handleLoad);
    image.addEventListener("error", handleError);

    image.src = faviconSrc;

    return () => {
      cancelled = true;
      image.removeEventListener("load", handleLoad);
      image.removeEventListener("error", handleError);
    };
  }, [faviconSrc]);

  const handleImageError = () => {
    projectFaviconPresence.set(faviconSrc, false);
    setProbe({ src: faviconSrc, present: false });
  };

  if (presentation === "favicon") {
    return hasFavicon ? (
      <img
        src={faviconSrc}
        alt=""
        aria-hidden="true"
        className={`${glyphClassName} rounded-[2px] object-contain`}
        onError={handleImageError}
      />
    ) : (
      <FolderGlyph className={glyphClassName} style={colorStyle(color)} />
    );
  }

  return (
    <>
      <FolderGlyph className={glyphClassName} style={colorStyle(color)} />
      {hasFavicon ? (
        <img
          src={faviconSrc}
          alt=""
          aria-hidden="true"
          className="absolute -right-1 -bottom-1 size-3 rounded-[4px] object-contain shadow-sm"
          onError={handleImageError}
        />
      ) : null}
    </>
  );
}
