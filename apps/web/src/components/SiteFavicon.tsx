// FILE: SiteFavicon.tsx
// Purpose: Render a website's favicon for a URL, falling back to the globe icon
//          while loading and on failure (no layout shift). Probes with Image()
//          so behavior matches the actual visible <img>, and shares a module-level
//          status cache so a known host renders immediately on re-render.
// Layer: Shared UI component
// Used by: markdown source links (ChatMarkdown) and read-only link chips
//          (MessagesTimeline). The Lexical composer chip uses the same lib
//          (siteFavicon.ts) imperatively rather than this component.

import { memo, useEffect, useState } from "react";

import { GlobeIcon } from "~/lib/icons";
import { extractHostname, resolveSiteFaviconUrl, siteFaviconStatusCache } from "~/lib/siteFavicon";
import { cn } from "~/lib/utils";

export interface SiteFaviconProps {
  /** Full URL (or bare host) the favicon should represent. */
  readonly url: string;
  /** Square px size for both the favicon and the globe fallback. Omit to size via `className`. */
  readonly size?: number | undefined;
  readonly className?: string | undefined;
}

export const SiteFavicon = memo(function SiteFavicon({ url, size, className }: SiteFaviconProps) {
  const host = extractHostname(url) ?? (url.includes(".") ? url : null);
  const faviconSrc = host ? resolveSiteFaviconUrl(host) : null;

  // Seed from the shared cache so a known host renders its icon immediately.
  const [status, setStatus] = useState<"ok" | "fail" | null>(() =>
    faviconSrc ? (siteFaviconStatusCache.get(faviconSrc) ?? null) : "fail",
  );

  // Probe with Image() so Electron/file-origin behaves like the visible <img>.
  useEffect(() => {
    if (!faviconSrc) {
      setStatus("fail");
      return;
    }
    const cached = siteFaviconStatusCache.get(faviconSrc);
    if (cached !== undefined) {
      setStatus(cached);
      return;
    }
    let cancelled = false;
    const image = new Image();
    const handleLoad = () => {
      siteFaviconStatusCache.set(faviconSrc, "ok");
      if (!cancelled) setStatus("ok");
    };
    const handleError = () => {
      siteFaviconStatusCache.set(faviconSrc, "fail");
      if (!cancelled) setStatus("fail");
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

  const sizeStyle = size === undefined ? undefined : { width: `${size}px`, height: `${size}px` };

  if (status === "ok" && faviconSrc) {
    return (
      <img
        src={faviconSrc}
        alt=""
        aria-hidden="true"
        className={cn("shrink-0 rounded-[2px] object-contain", className)}
        style={sizeStyle}
        onError={() => {
          siteFaviconStatusCache.set(faviconSrc, "fail");
          setStatus("fail");
        }}
      />
    );
  }

  return <GlobeIcon aria-hidden="true" className={className} style={sizeStyle} />;
});
