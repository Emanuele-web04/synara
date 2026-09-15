// FILE: desktop-package-files.ts
// Purpose: Exclude measured, non-runtime payloads from the packaged desktop app.
// Layer: Release/build policy. Never mutates the staged dependency installation.

const COMPILED_SOURCE_PACKAGES = [
  "effect",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "openai",
  "@anthropic-ai/sdk",
  "zod",
] as const;

// These packages expose compiled JS and declarations outside src/. Zod's
// @zod/source condition is development-only. Keep all declarations, Pi docs /
// examples, JS module formats, grammars, locales, and native runtime fallbacks.
// Diagnostic builds can restore maps and original sources without editing policy.
export function desktopDependencyFileExclusions(includeSources = false): string[] {
  return [
    "!**/node_modules/**/*.tsbuildinfo",
    ...(includeSources
      ? []
      : [
          "!**/node_modules/**/*.{js,mjs,cjs,ts,mts,cts}.map",
          ...COMPILED_SOURCE_PACKAGES.map((name) => `!**/node_modules/${name}/src/**`),
        ]),
  ];
}

export function desktopPlatformFileExclusions(platform: "mac" | "linux" | "win"): string[] {
  // Keep buildResources untouched for installer icons and code signing. Only
  // filter the copy used at runtime, retaining both default/custom icon choices.
  const unusedIcons = {
    mac: ["app-icon-linux.png", "app-icon-windows.ico", "icon.ico", "icon.png", "icon.icns"],
    linux: [
      "app-icon-macos.png",
      "app-icon-windows.ico",
      "dock-icon.png",
      "dock-icon-dark.png",
      "icon.icns",
      "icon.ico",
    ],
    win: [
      "app-icon-macos.png",
      "app-icon-linux.png",
      "dock-icon.png",
      "dock-icon-dark.png",
      "icon.icns",
      "icon.png",
    ],
  } as const;
  const otherPtyPlatforms = {
    mac: ["win32", "linux"],
    linux: ["darwin", "win32"],
    win: ["darwin", "linux"],
  } as const;
  return [
    "!apps/desktop/prod-resources/entitlements.mac*.plist",
    ...unusedIcons[platform].map((name) => `!apps/desktop/prod-resources/${name}`),
    // Retain all architectures for this OS, including universal macOS builds,
    // plus the rebuilt build/Release bindings and Windows conpty dependencies.
    ...otherPtyPlatforms[platform].map(
      (name) => `!**/node_modules/node-pty/prebuilds/${name}-*/**`,
    ),
  ];
}
