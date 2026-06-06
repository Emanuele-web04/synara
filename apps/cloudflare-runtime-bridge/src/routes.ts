/**
 * Bridge route parsing.
 *
 * The Worker entrypoint owns instance-collection routing (create / address an
 * instance by id); a per-instance Durable Object owns the instance sub-routes.
 * This module turns a request path into a typed route so both layers branch on
 * a tagged value rather than re-parsing strings.
 *
 * @module routes
 */

/** A route addressed at the instance collection (no instance id yet). */
export type CollectionRoute =
  | { readonly kind: "create-instance" }
  | { readonly kind: "instance"; readonly instanceId: string; readonly sub: InstanceRoute };

/** A route addressed at one instance (handled by its Durable Object). */
export type InstanceRoute =
  | { readonly kind: "get" }
  | { readonly kind: "delete" }
  | { readonly kind: "exec" }
  | { readonly kind: "logs" }
  | { readonly kind: "terminal" }
  | { readonly kind: "files" }
  | { readonly kind: "files-watch" }
  | { readonly kind: "ports" }
  | { readonly kind: "network-policy" }
  | { readonly kind: "renew-activity" }
  | { readonly kind: "unknown" };

const parseInstanceSubRoute = (segments: ReadonlyArray<string>, method: string): InstanceRoute => {
  if (segments.length === 0) {
    if (method === "DELETE") {
      return { kind: "delete" };
    }
    return { kind: "get" };
  }
  const [head, next] = segments;
  switch (head) {
    case "exec":
      return { kind: "exec" };
    case "logs":
      return { kind: "logs" };
    case "terminal":
      return { kind: "terminal" };
    case "files":
      return next === "watch" ? { kind: "files-watch" } : { kind: "files" };
    case "ports":
      return { kind: "ports" };
    case "network-policy":
      return { kind: "network-policy" };
    case "renew-activity":
      return { kind: "renew-activity" };
    default:
      return { kind: "unknown" };
  }
};

/**
 * Parse a request into a collection route. Returns `null` for paths outside the
 * `/instances` namespace so the caller can 404 them.
 */
export const parseRoute = (request: Request): CollectionRoute | null => {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments[0] !== "instances") {
    return null;
  }
  if (segments.length === 1) {
    return { kind: "create-instance" };
  }
  const instanceId = segments[1];
  if (instanceId === undefined || instanceId.length === 0) {
    return null;
  }
  const sub = parseInstanceSubRoute(segments.slice(2), request.method);
  return { kind: "instance", instanceId, sub };
};
