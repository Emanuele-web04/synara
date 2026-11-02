import { RemoteResource, type RemoteResourceReference } from "@synara/contracts";
import { remoteResourceRoute } from "@synara/shared/remoteResources";
import { Schema } from "effect";

export interface WorkspaceResourceRequest {
  readonly body?: Blob | Uint8Array<ArrayBuffer> | string;
  readonly signal?: AbortSignal;
}

export type WorkspaceResourceRequester = (
  resource: RemoteResource,
  request?: WorkspaceResourceRequest,
) => Promise<Response>;

function bodySize(body: NonNullable<WorkspaceResourceRequest["body"]>): number {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  // Files and Blobs can originate in the child realm, where instanceof Blob is false.
  const tag = Object.prototype.toString.call(body);
  if (
    (tag === "[object Blob]" || tag === "[object File]") &&
    "size" in body &&
    Number.isSafeInteger(body.size) &&
    body.size >= 0
  )
    return body.size;
  throw new Error("Unsupported resource request body.");
}

/** The resource manifest, never a caller URL or header, determines the HTTP operation. */
export function workspaceResourceRequestInit(
  resource: RemoteResource,
  request: WorkspaceResourceRequest = {},
): RequestInit {
  const route = remoteResourceRoute(resource);
  const { body, signal } = request;
  if (route.method === "GET" && body !== undefined)
    throw new Error("This resource does not accept an upload.");
  if (route.method === "POST" && (body === undefined || bodySize(body) > route.maxBodyBytes))
    throw new Error("Resource request body exceeds its permitted size.");
  const contentType =
    resource.kind === "attachment-cancel"
      ? "application/json"
      : resource.kind === "attachment-upload" || resource.kind === "voice-upload"
        ? resource.mimeType
        : undefined;
  return {
    method: route.method,
    credentials: "include",
    ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(signal ? { signal } : {}),
  };
}

/** Runs in the controller realm so Electron's main-frame-only resource guard stays intact. */
export function createWorkspaceResourceRequester(options: {
  readonly environmentId: RemoteResourceReference["environmentId"];
  readonly isAvailable: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly resourceUrl: (reference: RemoteResourceReference) => string | null;
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal;
}): WorkspaceResourceRequester {
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  const unsubscribe = options.subscribe(() => {
    if (!options.isAvailable()) stop();
  });
  const cleanup = () => {
    unsubscribe();
    options.signal.removeEventListener("abort", stop);
  };
  lifetime.signal.addEventListener("abort", cleanup, { once: true });
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted || !options.isAvailable()) stop();

  const ensureAvailable = () => {
    if (!options.isAvailable()) stop();
    lifetime.signal.throwIfAborted();
  };
  return async (input, request = {}) => {
    ensureAvailable();
    request.signal?.throwIfAborted();
    const resource = Schema.decodeUnknownSync(RemoteResource)(input);
    const init = workspaceResourceRequestInit(resource, request);
    const url = options.resourceUrl({ environmentId: options.environmentId, resource });
    if (!url) throw new Error("Remote resources require the updated desktop bridge.");
    const response = await options.fetch(url, {
      ...init,
      signal: AbortSignal.any([lifetime.signal, ...(request.signal ? [request.signal] : [])]),
    });
    ensureAvailable();
    return response;
  };
}
