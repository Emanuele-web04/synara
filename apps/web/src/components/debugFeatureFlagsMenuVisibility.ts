export const DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY = "dpcode:show-debug-feature-flags-menu";

interface DebugFeatureFlagsMenuVisibilityInput {
  readonly isDev: boolean;
  readonly hostname: string;
  readonly storageValue: string | null;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "");

  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1" ||
    normalizedHostname === "[::1]"
  );
}

export function shouldShowDebugFeatureFlagsMenu(
  input: DebugFeatureFlagsMenuVisibilityInput,
): boolean {
  return (
    input.isDev &&
    isLoopbackHostname(input.hostname) &&
    input.storageValue === "true"
  );
}

export function readDebugFeatureFlagsMenuVisibility(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return shouldShowDebugFeatureFlagsMenu({
      isDev: import.meta.env.DEV,
      hostname: window.location.hostname,
      storageValue: window.localStorage.getItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY),
    });
  } catch {
    return false;
  }
}
