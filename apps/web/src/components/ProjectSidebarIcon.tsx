// FILE: ProjectSidebarIcon.tsx
// Purpose: Render the standard project folder icon with an optional favicon badge overlay.
// Layer: Sidebar UI component
// Exports: ProjectSidebarIcon

import { useEffect, useState } from "react";

import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { FolderClosed, FolderOpen } from "./FolderClosed";

const projectFaviconPresence = new Map<string, boolean>();

function resolveProjectFaviconUrl(cwd: string): string {
  const params = new URLSearchParams({ cwd, fallback: "none" });
  return resolveWsHttpUrl(`/api/project-favicon?${params.toString()}`);
}

export function ProjectSidebarIcon({
  cwd,
  expanded,
  glyphClassName = "size-4",
}: {
  cwd: string;
  expanded: boolean;
  glyphClassName?: string;
}) {
  const faviconSrc = resolveProjectFaviconUrl(cwd);
  const [hasFavicon, setHasFavicon] = useState<boolean>(
    () => projectFaviconPresence.get(faviconSrc) === true,
  );
  const FolderGlyph = expanded ? FolderOpen : FolderClosed;

  // Probe with Image() so Electron/file-origin behaves like the actual visible <img>.
  useEffect(() => {
    const cached = projectFaviconPresence.get(faviconSrc);
    if (cached !== undefined) {
      setHasFavicon(cached);
      return;
    }

    let cancelled = false;
    const image = new Image();
    const handleLoad = () => {
      projectFaviconPresence.set(faviconSrc, true);
      if (!cancelled) {
        setHasFavicon(true);
      }
    };
    const handleError = () => {
      projectFaviconPresence.set(faviconSrc, false);
      if (!cancelled) {
        setHasFavicon(false);
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

  return (
    <>
      <FolderGlyph className={glyphClassName} />
      {hasFavicon ? (
        <img
          src={faviconSrc}
          alt=""
          aria-hidden="true"
          className="absolute -right-1 -bottom-1 size-3 rounded-[4px] object-contain shadow-sm"
          onError={() => {
            projectFaviconPresence.set(faviconSrc, false);
            setHasFavicon(false);
          }}
        />
      ) : null}
    </>
  );
}
