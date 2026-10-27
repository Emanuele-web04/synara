import type { RemoteResource } from "@synara/contracts";
import { remoteResourceRoute, REMOTE_RESOURCE_LOCAL_PREFIX } from "@synara/shared/remoteResources";
import { readExecutionContext } from "./hosts/executionContext";

export function resolveExecutionResource(resource: RemoteResource): string {
  const context = readExecutionContext();
  if (!context?.remote) {
    const route = remoteResourceRoute(resource);
    return resolveWsHttpUrl(route.path, { requireBackend: route.method === "POST" });
  }
  if (!context.remoteHostId) throw new Error("Remote execution identity is unavailable");
  const reference = { environmentId: context.execution.environmentId, resource };
  if (window.desktopBridge) {
    const url = window.desktopBridge.remoteResourceUrl?.(context.remoteHostId, reference);
    if (!url) throw new Error("Remote resources require the updated desktop bridge");
    return url;
  }
  // The browser uses its same-origin HttpOnly owner session. No credential is
  // returned to this resolver or copied from the controller WebSocket URL.
  const url = new URL(
    `${REMOTE_RESOURCE_LOCAL_PREFIX}${encodeURIComponent(context.remoteHostId)}`,
    window.location.origin,
  );
  url.searchParams.set("reference", JSON.stringify(reference));
  return url.toString();
}

// FILE: wsHttpUrl.ts
// Purpose: Resolves server HTTP URLs from the active WebSocket bridge so desktop <img>/download
// requests carry the same legacy startup token already used for the WS connection.
// Layer: Web utility
// Exports: resolveWsHttpUrl, toAttachmentPreviewUrl

// Build a fully-qualified HTTP URL for `rawPath` against the same server the WS connection uses.
// On desktop the page is served from a custom protocol scheme, so <img>/<a download> with a
// relative path never reaches the server. We mirror the WS host and forward the legacy token
// query param so authenticated GET routes (attachments, local-image, …) can authorize the
// request without touching cookies.
export function resolveWsHttpUrl(
  rawPath: string,
  options: { readonly requireBackend?: boolean } = {},
): string {
  if (typeof window === "undefined") return rawPath;
  if (readExecutionContext()?.remote)
    throw new Error("Remote execution resources must use a typed reference");
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  // A mutation must not POST to the packaged app document when its backend
  // disappears. GET callers can still render while that backend reconnects;
  // the desktop protocol refuses their API paths instead of serving the SPA.
  const resolveFallback = (): string => {
    if (!options.requireBackend) return new URL(rawPath, window.location.origin).toString();
    try {
      const absoluteUrl = new URL(rawPath);
      if (absoluteUrl.protocol === "http:" || absoluteUrl.protocol === "https:") {
        return absoluteUrl.toString();
      }
    } catch {
      // Relative resource paths still require a real backend origin below.
    }
    if (!window.desktopBridge) {
      const browserUrl = new URL(rawPath, window.location.origin);
      if (browserUrl.protocol === "http:" || browserUrl.protocol === "https:") {
        return browserUrl.toString();
      }
    }
    throw new Error("The desktop connection is unavailable. Reconnect and try again.");
  };
  if (!wsCandidate) return resolveFallback();
  try {
    const wsUrl = new URL(wsCandidate);
    if (!["ws:", "wss:", "http:", "https:"].includes(wsUrl.protocol) || !wsUrl.hostname) {
      throw new Error("Unsupported backend URL");
    }
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    const serverUrl = new URL(`${protocol}//${wsUrl.host}`);
    const httpUrl = new URL(rawPath, serverUrl);
    if (options.requireBackend && !["http:", "https:"].includes(httpUrl.protocol)) {
      throw new Error("Unsupported resource URL");
    }
    const legacyToken = wsUrl.searchParams.get("token");
    const targetsServerOrigin =
      httpUrl.protocol === serverUrl.protocol && httpUrl.host === serverUrl.host;
    if (legacyToken && targetsServerOrigin && !httpUrl.searchParams.has("token")) {
      httpUrl.searchParams.set("token", legacyToken);
    }
    return httpUrl.toString();
  } catch {
    return resolveFallback();
  }
}

export function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/attachments/") && readExecutionContext()?.remote) {
    const attachmentId = rawUrl.slice("/attachments/".length);
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(attachmentId))
      throw new Error("Unsupported remote attachment reference");
    return resolveExecutionResource({ kind: "attachment", attachmentId });
  }
  if (rawUrl.startsWith("/")) {
    return resolveWsHttpUrl(rawUrl);
  }
  return rawUrl;
}
