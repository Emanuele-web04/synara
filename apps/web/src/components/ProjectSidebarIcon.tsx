// FILE: ProjectSidebarIcon.tsx
// Purpose: Render the standard project folder icon with an optional favicon badge overlay.
// Layer: Sidebar UI component
// Exports: ProjectSidebarIcon

import { useEffect, useState } from "react";
import { HiOutlineFolderOpen } from "react-icons/hi2";
import { IoFolderOutline } from "react-icons/io5";

const projectFaviconPresence = new Map<string, boolean>();

function resolveServerHttpOrigin(): string {
  if (typeof window === "undefined") return "";

  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;

  if (!wsCandidate) return window.location.origin;

  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function resolveProjectFaviconUrl(cwd: string): string {
  const origin = resolveServerHttpOrigin();
  const url =
    origin.length > 0
      ? new URL("/api/project-favicon", origin)
      : new URL("/api/project-favicon", "http://localhost");
  url.searchParams.set("cwd", cwd);
  url.searchParams.set("fallback", "none");
  return origin.length > 0 ? url.toString() : `${url.pathname}${url.search}`;
}

export function ProjectSidebarIcon({ cwd, expanded }: { cwd: string; expanded: boolean }) {
  const faviconSrc = resolveProjectFaviconUrl(cwd);
  const [hasFavicon, setHasFavicon] = useState<boolean>(
    () => projectFaviconPresence.get(faviconSrc) === true,
  );
  const FolderGlyph = expanded ? HiOutlineFolderOpen : IoFolderOutline;

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
      <FolderGlyph className="size-4" />
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
