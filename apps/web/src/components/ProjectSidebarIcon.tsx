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
  // Keyed by src: a cwd change derives back to the cache-seeded default in the
  // same render, so the probe effect never needs a synchronous setState.
  const [probe, setProbe] = useState<{ src: string; present: boolean } | null>(() => {
    const cached = projectFaviconPresence.get(faviconSrc);
    return cached === undefined ? null : { src: faviconSrc, present: cached };
  });
  const hasFavicon = probe !== null && probe.src === faviconSrc && probe.present;
  const FolderGlyph = expanded ? FolderOpen : FolderClosed;

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
            setProbe({ src: faviconSrc, present: false });
          }}
        />
      ) : null}
    </>
  );
}
