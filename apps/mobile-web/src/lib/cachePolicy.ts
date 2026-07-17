const SHELL_STATIC_PREFIX = "/mobile/assets/";
const SHELL_STATIC_PATHS = new Set([
  "/mobile/",
  "/mobile/manifest.webmanifest",
  "/mobile/icons/synara.svg",
  "/mobile/icons/synara-maskable.svg",
  "/mobile/icons/synara-192.png",
  "/mobile/icons/synara-512.png",
  "/mobile/icons/synara-maskable-192.png",
  "/mobile/icons/synara-maskable-512.png",
  "/mobile/icons/apple-touch-icon.png",
]);

export function isMobileNavigation(url: URL, mode: RequestMode): boolean {
  return mode === "navigate" && url.pathname.startsWith("/mobile/");
}

export function isCacheableShellRequest(url: URL, origin: string): boolean {
  if (url.origin !== origin) return false;
  return url.pathname.startsWith(SHELL_STATIC_PREFIX) || SHELL_STATIC_PATHS.has(url.pathname);
}

export function notificationPreview(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (sanitized.length === 0) return undefined;
  return sanitized.slice(0, 160);
}
