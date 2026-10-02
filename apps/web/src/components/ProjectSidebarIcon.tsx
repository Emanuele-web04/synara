// FILE: ProjectSidebarIcon.tsx
// Purpose: Render a project's glyph: its chosen emoji or icon, or the standard folder with an
//          optional favicon badge overlay or a primary favicon in compact rows.
// Layer: Sidebar UI component
// Exports: ProjectSidebarIcon, ProjectEmojiGlyph

import type { ProjectId } from "@synara/contracts";
import { useState, type CSSProperties } from "react";

import { CentralIcon } from "~/lib/central-icons";
import {
  DEFAULT_PROJECT_ICON,
  projectColorValue,
  type ProjectAppearance,
  type ProjectColor,
} from "~/lib/projectAppearance";
import { cn } from "~/lib/utils";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { FolderIcon, FolderOpenIcon } from "~/lib/icons";

function resolveProjectFaviconUrl(projectId: ProjectId): string {
  const params = new URLSearchParams({ projectId });
  return resolveWsHttpUrl(`/api/project-favicon?${params.toString()}`);
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
  projectId,
  expanded,
  appearance,
  glyphClassName: glyphClassNameProp,
  presentation = "badge",
}: {
  projectId?: ProjectId | null | undefined;
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
  if (appearance?.kind === "icon" && appearance.color) {
    const FolderGlyph = expanded ? FolderOpenIcon : FolderIcon;
    return <FolderGlyph className={glyphClassName} style={colorStyle(appearance.color)} />;
  }
  return (
    <ProjectFolderIcon
      key={projectId ?? "preview"}
      projectId={projectId}
      expanded={expanded}
      color={appearance?.color ?? null}
      glyphClassName={glyphClassName}
      presentation={presentation}
    />
  );
}

function ProjectFolderIcon({
  projectId,
  expanded,
  color,
  glyphClassName,
  presentation,
}: {
  projectId: ProjectId | null | undefined;
  expanded: boolean;
  color: ProjectColor | null;
  glyphClassName: string;
  presentation: "badge" | "favicon";
}) {
  const faviconSrc = projectId ? resolveProjectFaviconUrl(projectId) : null;
  // The source key resets the visible image immediately when the project changes.
  // Only that image's load event hides the folder; no separate probe can race it.
  const [imageState, setImageState] = useState<{ src: string; loaded: boolean } | null>(null);
  const hasFavicon = faviconSrc !== null && imageState?.src === faviconSrc && imageState.loaded;
  const failed = faviconSrc !== null && imageState?.src === faviconSrc && !imageState.loaded;
  const FolderGlyph = expanded ? FolderOpenIcon : FolderIcon;

  if (presentation === "favicon") {
    return (
      <span
        className={cn("relative inline-flex shrink-0 items-center justify-center", glyphClassName)}
      >
        <FolderGlyph
          className={cn("absolute inset-0 size-full", hasFavicon && "invisible")}
          style={colorStyle(color)}
        />
        {faviconSrc && !failed ? (
          <img
            key={faviconSrc}
            src={faviconSrc}
            alt=""
            aria-hidden="true"
            className={cn("size-full rounded-[2px] object-contain", !hasFavicon && "opacity-0")}
            onLoad={() => setImageState({ src: faviconSrc, loaded: true })}
            onError={() => setImageState({ src: faviconSrc, loaded: false })}
          />
        ) : null}
      </span>
    );
  }

  return (
    <>
      <FolderGlyph className={glyphClassName} style={colorStyle(color)} />
      {faviconSrc && !failed ? (
        <img
          key={faviconSrc}
          src={faviconSrc}
          alt=""
          aria-hidden="true"
          className={cn(
            "absolute -right-1 -bottom-1 size-3 rounded-[4px] object-contain shadow-sm",
            !hasFavicon && "opacity-0",
          )}
          onLoad={() => setImageState({ src: faviconSrc, loaded: true })}
          onError={() => setImageState({ src: faviconSrc, loaded: false })}
        />
      ) : null}
    </>
  );
}
