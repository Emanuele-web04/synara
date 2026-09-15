// FILE: desktop-package-files.ts
// Purpose: Exclude measured non-runtime payloads without changing dependency resolution.
// Layer: Desktop packaging policy (the workspace and published CLI stay intact).

export type DesktopPackagePlatform = "mac" | "linux" | "win";

export function includeDesktopDependencySources(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  // Keep existing app diagnostic switches useful, and allow dependency-only diagnostics.
  return [
    "SYNARA_DESKTOP_DEPENDENCY_SOURCES",
    "SYNARA_DESKTOP_SOURCEMAP",
    "SYNARA_SERVER_SOURCEMAP",
    "SYNARA_WEB_SOURCEMAP",
  ].some((name) => ["1", "true", "hidden", "yes", "on"].includes(env[name]?.trim().toLowerCase() ?? ""));
}

export function desktopPackageFiles(
  platform: DesktopPackagePlatform,
  includeSources: boolean,
): string[] {
  const files = [
    "**/*",
    // electron-builder consumes these from buildResources; runtime never reads
    // the second copy in prod-resources. The installed application icon remains.
    "!apps/desktop/prod-resources/{entitlements.mac.plist,entitlements.mac.inherit.plist}",
    "!apps/desktop/prod-resources/icon.icns",
    "!**/node_modules/**/*.tsbuildinfo",
  ];

  if (!includeSources) {
    files.push(
      "!**/node_modules/**/*.{js,mjs,cjs,ts,mts,cts}.map",
      "!**/node_modules/**/*.d.{mts,cts}",
      // Only these audited packages expose compiled runtime JS outside src/.
      // Do not generalize this to all .ts files: agent extensions can execute TS.
      ...[
        "effect",
        "@effect/platform-node",
        "@effect/platform-node-shared",
        "openai",
        "@anthropic-ai/sdk",
        "zod",
      ].map((name) => `!**/node_modules/${name}/src/**`),
    );
  }

  // Preserve every app-icon preference on its own platform, including macOS
  // light/dark artwork and Windows notification/taskbar fallback resources.
  if (platform !== "mac") {
    files.push(
      "!apps/desktop/prod-resources/app-icon-macos.png",
      "!apps/desktop/prod-resources/dock-icon*.png",
      "!**/node_modules/node-pty/prebuilds/darwin-*/**",
    );
  }
  if (platform !== "linux") {
    files.push("!apps/desktop/prod-resources/app-icon-linux.png");
  }
  if (platform !== "win") {
    files.push(
      "!apps/desktop/prod-resources/app-icon-windows.ico",
      "!apps/desktop/prod-resources/icon.ico",
      "!**/node_modules/node-pty/prebuilds/win32-*/**",
    );
  }
  if (platform === "linux") {
    // The shipped Electron runtime is glibc-linked. The SDK selects this same
    // libc via process.report; its musl fallback cannot run on this target.
    // Keep the matching glibc binary and all SDK JavaScript/API entrypoints.
    files.push("!**/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl/**");
  }
  return files;
}
