import {
  LOCAL_IMAGE_ROUTE_PATH,
  SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX,
} from "@synara/shared/localPreviewFiles";
import { isLocalAbsolutePath, isWindowsAbsolutePath } from "@synara/shared/path";

import { resolveWsHttpUrl } from "./wsHttpUrl";

function normalizeMarkdownImagePath(src: string): string {
  const trimmed = src.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(trimmed).pathname);
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

export function isLocalImageMarkdownSrc(src: string | undefined): src is string {
  if (!src) {
    return false;
  }
  const normalized = normalizeMarkdownImagePath(src);
  if (!SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX.test(normalized)) {
    return false;
  }
  // Windows absolute paths (C:\foo.png) are local images even though the drive prefix looks like a URI scheme
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

// Grants must name the same decoded file as the preview HTTP request.
export function localImageAbsolutePath(src: string): string | null {
  const normalized = normalizeMarkdownImagePath(src);
  return isLocalImageMarkdownSrc(src) && isLocalAbsolutePath(normalized) ? normalized : null;
}

export function buildLocalImageUrl(input: {
  readonly src: string;
  readonly cwd: string | undefined;
  readonly download?: boolean;
  // accept explicit undefined so callers can forward `previewGrant: string|null|undefined` under exactOptionalPropertyTypes; falsy grants are omitted below
  readonly grant?: string | null | undefined;
  readonly cacheKey?: string | number | undefined;
}): string {
  const params = new URLSearchParams({ path: normalizeMarkdownImagePath(input.src) });
  if (input.cwd) {
    params.set("cwd", input.cwd);
  }
  if (input.grant) {
    params.set("grant", input.grant);
  }
  if (input.cacheKey !== undefined) {
    params.set("v", String(input.cacheKey));
  }
  if (input.download) {
    params.set("download", "1");
  }
  // route through the WS-derived HTTP origin so desktop builds (custom protocol) carry the same legacy startup token attachments use; web/dev falls back to relative
  return resolveWsHttpUrl(`${LOCAL_IMAGE_ROUTE_PATH}?${params.toString()}`);
}

export function localImageFileName(src: string): string {
  const normalized = normalizeMarkdownImagePath(src);
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
