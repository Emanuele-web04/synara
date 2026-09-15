// FILE: desktop-package-files.ts
// Purpose: Excludes audited build-only and non-target files from desktop artifacts.
// Layer: Release/build policy; never changes the workspace or standalone CLI package.

export type DesktopPackagePlatform = "linux" | "mac" | "win";

// These packages ship compiled runtime entry points separately from their
// TypeScript sources. Do not generalize this to every src/ directory: e.g.
// betterwright's runtime lives in dist/src, and extensions can execute TS.
const COMPILED_SOURCE_PACKAGES = [
  "effect",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "@anthropic-ai/sdk",
  "openai",
  "zod",
] as const;

const OTHER_PLATFORM_RESOURCES: Record<DesktopPackagePlatform, ReadonlyArray<string>> = {
  mac: ["app-icon-linux.png", "app-icon-windows.ico", "icon.ico"],
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
  ],
};

export function createDesktopPackageFilePatterns(
  platform: DesktopPackagePlatform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const diagnosticBuild = [
    "SYNARA_DESKTOP_SOURCEMAP",
    "SYNARA_SERVER_SOURCEMAP",
    "SYNARA_WEB_SOURCEMAP",
  ].some((key) => /^(1|true|hidden)$/.test(environment[key]?.trim().toLowerCase() ?? ""));

  const patterns = [
    "**/*",
    // macOS gets one real, executable source tree via extraFiles; other
    // platforms cannot run the Swift simulator helper. The CLI keeps its copy.
    "!apps/server/dist/device-helper/**",
    "!apps/server/dist/client/mockServiceWorker.js{,.gz,.br}",
    "!apps/desktop/prod-resources/entitlements.mac*.plist",
    ...OTHER_PLATFORM_RESOURCES[platform].map((name) => `!apps/desktop/prod-resources/${name}`),
  ];

  if (!diagnosticBuild) {
    patterns.push(
      // Only JavaScript/TypeScript/CSS source maps, not arbitrary .map data.
      "!**/node_modules/**/*.{js,mjs,cjs,ts,mts,cts,css}.map",
      ...COMPILED_SOURCE_PACKAGES.map((name) => `!**/node_modules/${name}/src/**`),
      "!**/node_modules/node-pty/src/**",
      "!**/node_modules/node-pty/lib/*.test.js",
    );
  }

  const nativePlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  for (const other of ["darwin", "linux", "win32"]) {
    if (other !== nativePlatform) {
      patterns.push(`!**/node_modules/node-pty/prebuilds/${other}-*/**`);
    }
  }

  if (platform === "linux") {
    // Electron's Linux distribution is glibc-based. The pinned SDK selects
    // the glibc package when process.report exposes glibcVersionRuntime; keep
    // that binary (including its health-probe use), not its 200 MiB musl twin.
    // This exclusion does not affect Bun installs or the standalone CLI.
    patterns.push("!**/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl/**");
  }

  return patterns;
}
