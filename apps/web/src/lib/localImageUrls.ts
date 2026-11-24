// FILE: localImageUrls.ts
// Purpose: Builds authenticated local-image URLs for markdown image/video previews and downloads.
// Layer: Web utility
// Exports: local image/video URL detection and builders
// Depends on: wsHttpUrl (so desktop requests carry the legacy startup token used by attachments)
//             and @synara/shared/localPreviewFiles for the canonical route + extension allowlist.

import {
  SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX,
  SUPPORTED_LOCAL_VIDEO_EXTENSION_REGEX,
} from "@synara/shared/localPreviewFiles";
import { isWindowsAbsolutePath } from "@synara/shared/path";

import { resolveExecutionResource } from "./wsHttpUrl";

export function normalizeMarkdownImagePath(src: string): string {
  const trimmed = src.trim();
  if (trimmed.startsWith("file://")) {
    try {
      const pathname = decodeURIComponent(new URL(trimmed).pathname);
      // `file:///C:/dir` parses to `/C:/dir`; drop the slash so the drive path stays native.
      return /^\/[A-Za-z]:[\\/]/.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return trimmed;
    }
  }
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

// Shared locality rule for markdown media: the extension must match the kind's
// allowlist and the source must be a filesystem path, not a URL with a scheme.
function isLocalMarkdownMediaSrc(src: string | undefined, extensionRegex: RegExp): src is string {
  if (!src) {
    return false;
  }
  const normalized = normalizeMarkdownImagePath(src);
  if (!extensionRegex.test(normalized)) {
    return false;
  }
  // Treat Windows-style absolute paths (e.g. `C:\foo\bar.png`) as local even though
  // their drive prefix would otherwise look like a URI scheme.
  if (isWindowsAbsolutePath(normalized)) {
    return true;
  }
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    !/^[a-z][a-z0-9+.-]*:/i.test(normalized)
  );
}

export function isLocalImageMarkdownSrc(src: string | undefined): src is string {
  return isLocalMarkdownMediaSrc(src, SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX);
}

export function isLocalVideoMarkdownSrc(src: string | undefined): src is string {
  return isLocalMarkdownMediaSrc(src, SUPPORTED_LOCAL_VIDEO_EXTENSION_REGEX);
}

export function buildLocalImageUrl(input: {
  readonly src: string;
  readonly cwd: string | undefined;
  /** Raw canonical host path has already been decoded; never interpret percent escapes twice. */
  readonly canonicalPath?: string | undefined;
  readonly download?: boolean;
  // Accept an explicit `undefined` (not just absent) so callers can forward an
  // optional `previewGrant: string | null | undefined` straight through under
  // exactOptionalPropertyTypes. Internally falsy grants are simply omitted below.
  readonly grant?: string | null | undefined;
  /** Changes the preview URL so an explicit reload bypasses browser caching. */
  readonly cacheKey?: string | number | undefined;
}): string {
  return resolveExecutionResource({
    kind: "workspace-preview",
    path: input.canonicalPath ?? normalizeMarkdownImagePath(input.src),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.grant ? { grant: input.grant } : {}),
    ...(input.cacheKey !== undefined ? { revision: String(input.cacheKey) } : {}),
    ...(input.download ? { download: true } : {}),
  });
}

export function localImageFileName(src: string): string {
  const normalized = normalizeMarkdownImagePath(src);
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
