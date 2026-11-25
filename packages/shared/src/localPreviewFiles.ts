// FILE: localPreviewFiles.ts
// Purpose: Single source of truth for the /api/local-image route shape consumed by
//          both the server (HTTP route + filesystem allowlist) and the web client
//          (URL builder + markdown image/video source detection). The route serves
//          every allowlisted preview file: images (rendered via <img>), videos
//          (rendered via a native <video>, streamed with HTTP Range requests) and
//          PDFs (rendered by the browser's built-in viewer in an <iframe>).
// Layer: Shared utility (no runtime dependencies)
// Exports: route path, preview-file extension allowlists, and helper predicates
//          derived from them.

export const LOCAL_IMAGE_ROUTE_PATH = "/api/local-image" as const;

// Lower-case extensions (with leading dot) that the server is willing to serve and
// the web client is willing to treat as local-image markdown sources. Keep these in
// sync with the MIME allowlist used elsewhere; this list is the canonical answer.
export const SUPPORTED_LOCAL_IMAGE_EXTENSIONS = [
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
] as const;

const SUPPORTED_LOCAL_IMAGE_EXTENSIONS_SET: ReadonlySet<string> = new Set(
  SUPPORTED_LOCAL_IMAGE_EXTENSIONS,
);

/** Lower-cased extension (with leading dot) of a path, or null when there is none. */
export function lowerCaseExtensionOf(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  return filePath.slice(dot).toLowerCase();
}

export function isSupportedLocalImagePath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && SUPPORTED_LOCAL_IMAGE_EXTENSIONS_SET.has(extension);
}

export const SUPPORTED_LOCAL_PDF_EXTENSION = ".pdf" as const;

export function isSupportedLocalPdfPath(filePath: string): boolean {
  return lowerCaseExtensionOf(filePath) === SUPPORTED_LOCAL_PDF_EXTENSION;
}

// Containers Chromium/Electron can play natively. Codec support inside them is
// not guaranteed (e.g. HEVC or ProRes `.mov`), so video surfaces must handle the
// element's `error` event with a download fallback.
export const SUPPORTED_LOCAL_VIDEO_EXTENSIONS = [".m4v", ".mov", ".mp4", ".ogv", ".webm"] as const;

const SUPPORTED_LOCAL_VIDEO_EXTENSIONS_SET: ReadonlySet<string> = new Set(
  SUPPORTED_LOCAL_VIDEO_EXTENSIONS,
);

export function isSupportedLocalVideoPath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && SUPPORTED_LOCAL_VIDEO_EXTENSIONS_SET.has(extension);
}

// Full allowlist for the /api/local-image serving route. Markdown media source
// detection (below) stays split by kind: an image regex for <img>, a video regex
// for <video>, and a `.pdf` link in chat markdown is never inlined at all.
export function isSupportedLocalPreviewFilePath(filePath: string): boolean {
  return (
    isSupportedLocalImagePath(filePath) ||
    isSupportedLocalVideoPath(filePath) ||
    isSupportedLocalPdfPath(filePath)
  );
}

function extensionSuffixRegex(extensions: readonly string[]): RegExp {
  const escaped = extensions.map((extension) =>
    extension.slice(1).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`\\.(?:${escaped.join("|")})$`, "i");
}

// Built from the canonical extensions lists so the web regexes never drift from
// the server allowlist. Anchored at end-of-string to match `.png`-style suffixes only.
export const SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX: RegExp = extensionSuffixRegex(
  SUPPORTED_LOCAL_IMAGE_EXTENSIONS,
);

export const SUPPORTED_LOCAL_VIDEO_EXTENSION_REGEX: RegExp = extensionSuffixRegex(
  SUPPORTED_LOCAL_VIDEO_EXTENSIONS,
);
