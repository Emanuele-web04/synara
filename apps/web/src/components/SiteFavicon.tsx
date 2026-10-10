// FILE: SiteFavicon.tsx
// Purpose: Render a website's favicon for a URL, falling back to the globe icon
//          while loading and on failure (no layout shift). Probes with Image()
//          so behavior matches the actual visible <img>, and shares a module-level
//          status cache so a known host renders immediately on re-render.
// Layer: Shared UI component
// Used by: markdown source links (ChatMarkdown), InlineLinkChip (composer + user bubble).

import { useEffect, useState } from "react";

import { GlobeIcon } from "~/lib/icons";
import {
  extractHostname,
  probeSiteFavicon,
  resolveSiteFaviconUrl,
  siteFaviconStatusCache,
} from "~/lib/siteFavicon";
import { cn } from "~/lib/utils";

export interface SiteFaviconProps {
  /** Full URL (or bare host) the favicon should represent. */
  readonly url: string;
  /** Square px size for both the favicon and the globe fallback. Omit to size via `className`. */
  readonly size?: number | undefined;
  readonly className?: string | undefined;
}

export const SiteFavicon = function SiteFavicon({ url, size, className }: SiteFaviconProps) {
  const host = extractHostname(url) ?? (url.includes(".") ? url : null);
  const faviconSrc = host ? resolveSiteFaviconUrl(host) : null;

  // Seed from the shared cache so a known host renders its icon immediately.
  // Keyed by src: a host change derives back to the pending/fallback state in
  // the same render, so the probe effect never sets state synchronously.
  const [probe, setProbe] = useState<{ src: string; status: "ok" | "fail" } | null>(() => {
    if (!faviconSrc) return null;
    const cached = siteFaviconStatusCache.get(faviconSrc);
    return cached === undefined ? null : { src: faviconSrc, status: cached };
  });
  const status: "ok" | "fail" | null = !faviconSrc
    ? "fail"
    : probe !== null && probe.src === faviconSrc
      ? probe.status
      : null;

  // Probe with Image() (via the shared, de-duped helper) so Electron/file-origin
  // behaves like the visible <img> and every consumer reuses one load per host.
  useEffect(() => {
    if (!faviconSrc) {
      return;
    }
    let cancelled = false;
    void probeSiteFavicon(faviconSrc).then((result) => {
      if (!cancelled) setProbe({ src: faviconSrc, status: result });
    });
    return () => {
      cancelled = true;
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
          setProbe({ src: faviconSrc, status: "fail" });
        }}
      />
    );
  }

  return <GlobeIcon aria-hidden="true" className={className} style={sizeStyle} />;
};
