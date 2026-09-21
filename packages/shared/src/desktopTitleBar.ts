export function supportsCustomTitleBar(platform: string): boolean {
  return platform === "win32" || platform === "linux";
}

export function defaultCustomTitleBarPreference(platform: string): boolean {
  return supportsCustomTitleBar(platform);
}

export function resolveCustomTitleBarActive(input: {
  readonly platform: string;
  readonly preference: boolean | null;
}): boolean {
  if (!supportsCustomTitleBar(input.platform)) {
    return false;
  }
  if (input.preference === null) {
    return defaultCustomTitleBarPreference(input.platform);
  }
  return input.preference;
}
