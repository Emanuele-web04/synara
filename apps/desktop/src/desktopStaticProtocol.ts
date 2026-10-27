// FILE: desktopStaticProtocol.ts
// Purpose: Resolves packaged desktop protocol requests within the prepared static root.
// Layer: Desktop main-process policy

import { existsSync } from "node:fs";
import * as Path from "node:path";

export type DesktopStaticProtocolResponse = { path: string } | { error: -6 };

type PathExists = (path: string) => boolean;

// Backend resources belong to the HTTP bridge, never the packaged SPA fallback.
function isBackendResourcePath(pathname: string): boolean {
  const normalized = Path.posix.normalize(pathname.replaceAll("\\", "/"));
  return ["/api", "/attachments", "/ws", "/v2"].some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

export function createDesktopStaticProtocolResolver(
  staticRoot: string,
  pathExists: PathExists = existsSync,
): (requestUrl: string, requestMethod?: string) => DesktopStaticProtocolResponse {
  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  return (requestUrl, requestMethod = "GET") => {
    if (requestMethod !== "GET" && requestMethod !== "HEAD") return { error: -6 };
    try {
      const url = new URL(requestUrl);
      if (isBackendResourcePath(url.pathname)) return { error: -6 };
      const rawPath = decodeURIComponent(url.pathname);
      if (isBackendResourcePath(rawPath)) return { error: -6 };
      const normalizedPath = Path.posix.normalize(rawPath).replace(/^\/+/, "");
      const isAssetRequest = Path.extname(url.pathname).length > 0;

      let candidate = fallbackIndex;
      if (!normalizedPath.includes("..")) {
        const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
        const resolvedPath = Path.join(staticRootResolved, requestedPath);
        if (Path.extname(resolvedPath)) {
          candidate = resolvedPath;
        } else {
          const nestedIndex = Path.join(resolvedPath, "index.html");
          candidate = pathExists(nestedIndex) ? nestedIndex : fallbackIndex;
        }
      }

      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      if (!isInRoot || !pathExists(resolvedCandidate)) {
        return isAssetRequest ? { error: -6 } : { path: fallbackIndex };
      }

      return { path: resolvedCandidate };
    } catch {
      return { path: fallbackIndex };
    }
  };
}
