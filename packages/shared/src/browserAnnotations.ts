const REDACTED_VALUE = "REDACTED";

const SAFE_QUERY_KEYS = new Set([
  "lang",
  "language",
  "locale",
  "mode",
  "order",
  "page",
  "section",
  "sort",
  "tab",
  "view",
]);

const SAFE_STATIC_PATH_SEGMENTS = new Set([
  "about",
  "activity",
  "app",
  "articles",
  "blog",
  "board",
  "boards",
  "calendar",
  "code",
  "dashboard",
  "details",
  "docs",
  "documentation",
  "download",
  "downloads",
  "editor",
  "features",
  "files",
  "general",
  "help",
  "history",
  "home",
  "index",
  "install",
  "installation",
  "issues",
  "landing",
  "next",
  "overview",
  "page",
  "pages",
  "pricing",
  "preview",
  "product",
  "products",
  "project",
  "projects",
  "repos",
  "repositories",
  "search",
  "settings",
  "support",
  "task",
  "tasks",
  "team",
  "teams",
  "thread",
  "threads",
  "tickets",
  "timeline",
  "workspace",
  "workspaces",
]);

const SAFE_STATIC_QUERY_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  mode: new Set([
    "auto",
    "compact",
    "dark",
    "default",
    "edit",
    "expanded",
    "light",
    "preview",
    "view",
  ]),
  order: new Set(["asc", "desc"]),
  section: new Set([
    "activity",
    "code",
    "comments",
    "details",
    "features",
    "files",
    "general",
    "history",
    "install",
    "installation",
    "overview",
    "preview",
    "settings",
  ]),
  sort: new Set([
    "created",
    "date",
    "name",
    "position",
    "priority",
    "status",
    "title",
    "updated",
  ]),
  tab: new Set([
    "activity",
    "code",
    "comments",
    "details",
    "files",
    "general",
    "history",
    "overview",
    "preview",
    "settings",
  ]),
  view: new Set([
    "board",
    "calendar",
    "compact",
    "details",
    "expanded",
    "grid",
    "kanban",
    "list",
    "preview",
    "table",
    "timeline",
  ]),
};

const SENSITIVE_PATH_KEYS = new Set([
  "account",
  "accounts",
  "auth",
  "authorize",
  "callback",
  "client",
  "clients",
  "contact",
  "contacts",
  "credential",
  "credentials",
  "customer",
  "customers",
  "employee",
  "employees",
  "invite",
  "invites",
  "join",
  "magic",
  "member",
  "members",
  "oauth",
  "patient",
  "patients",
  "people",
  "person",
  "profile",
  "profiles",
  "record",
  "records",
  "reset",
  "s",
  "session",
  "sessions",
  "share",
  "shared",
  "shares",
  "staff",
  "token",
  "tokens",
  "user",
  "users",
  "verification",
  "verify",
]);

function decodeForInspection(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksPrivate(value: string): boolean {
  const decoded = decodeForInspection(value);
  return (
    decoded.length > 96 ||
    /(?:^|[^A-Za-z0-9])(?:bearer|password|passwd|secret|token|credential)(?:$|[^A-Za-z0-9])/iu.test(
      decoded,
    ) ||
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u.test(decoded) ||
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/u.test(decoded) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      decoded,
    ) ||
    /^\d{4,}$/u.test(decoded) ||
    (decoded.length >= 6 &&
      /^[A-Za-z0-9._~-]+$/u.test(decoded) &&
      /[A-Za-z]/u.test(decoded) &&
      /\d/u.test(decoded))
  );
}

function isSensitivePathKey(value: string): boolean {
  return value
    .toLowerCase()
    .split(/[-_]/u)
    .some((part) => SENSITIVE_PATH_KEYS.has(part));
}

function isExplicitlyStaticPathSegment(value: string): boolean {
  if (value === REDACTED_VALUE) return true;
  const normalized = value.toLowerCase();
  return SAFE_STATIC_PATH_SEGMENTS.has(normalized) || isSensitivePathKey(normalized);
}

function sanitizePathname(pathname: string): string {
  let redactNext = false;
  return pathname
    .split("/")
    .map((segment) => {
      if (segment.length === 0) return segment;
      const decoded = decodeForInspection(segment);
      const shouldRedact =
        redactNext || looksPrivate(decoded) || !isExplicitlyStaticPathSegment(decoded);
      redactNext = isSensitivePathKey(decoded);
      return shouldRedact ? REDACTED_VALUE : segment;
    })
    .join("/");
}

function isSafeQueryValue(key: string, value: string): boolean {
  if (value === REDACTED_VALUE) return true;
  if (looksPrivate(value)) return false;
  if (key === "lang" || key === "language" || key === "locale") {
    return /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(value);
  }
  if (key === "page") return /^\d{1,6}$/u.test(value);
  return SAFE_STATIC_QUERY_VALUES[key]?.has(value.toLowerCase()) ?? false;
}

function sanitizeSearchParams(searchParams: URLSearchParams): string {
  const sanitized = new URLSearchParams();
  for (const [key, value] of searchParams) {
    const normalizedKey = key.trim().toLowerCase();
    if (!SAFE_QUERY_KEYS.has(normalizedKey)) {
      continue;
    }
    sanitized.append(
      normalizedKey,
      isSafeQueryValue(normalizedKey, value) ? value : REDACTED_VALUE,
    );
  }
  return sanitized.toString();
}

/**
 * Produces the durable/public URL attached to a browser annotation.
 *
 * The full live URL may contain credentials, magic links, personal identifiers,
 * opaque tokens, or application state. It must remain an ephemeral browser
 * affinity value and never cross the annotation persistence boundary.
 */
export function sanitizeBrowserAnnotationUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    const canonicalInput = url.href;
    url.username = "";
    url.password = "";
    url.pathname = sanitizePathname(url.pathname);
    url.search = sanitizeSearchParams(url.searchParams);
    url.hash = "";
    return url.href === canonicalInput ? value : url.href;
  } catch {
    return "";
  }
}
