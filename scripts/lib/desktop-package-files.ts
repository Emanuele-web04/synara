// FILE: desktop-package-files.ts
// Purpose: Omit verified non-runtime payloads from desktop packaging only.
// Layer: Release/build helper

import { parseOptionalBooleanEnvValue } from "./env-bool.ts";

export interface DesktopPackageFilesInput {
  readonly platform: "linux" | "mac" | "win";
  readonly dependencySourcemaps?: boolean;
  readonly linuxGlibc?: boolean;
}

// These packages publish runtime exports as compiled JS, not their src trees.
// Do NOT generalize to **/src: other dependencies execute JS/TS from src.
// Remove only source code, never whole directories: vendored license notices
// in these trees still need to ship even when their compiled code lives elsewhere.
export const COMPILED_DEPENDENCY_SOURCE_TREES = [
  "effect",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "@effect/sql-sqlite-bun",
  "openai",
  "@anthropic-ai/sdk",
] as const;

export function isGlibcRuntime(report: unknown): boolean {
  if (!report || typeof report !== "object" || !("header" in report)) return false;
  const header = report.header;
  return (
    !!header &&
    typeof header === "object" &&
    "glibcVersionRuntime" in header &&
    typeof header.glibcVersionRuntime === "string" &&
    header.glibcVersionRuntime.length > 0
  );
}

export function desktopPackageFiles(input: DesktopPackageFilesInput): string[] {
  const files = [
    "**/*",
    // electron-builder already omits .d.ts; cover the ESM/CJS equivalents too.
    "!node_modules/**/*.{d.mts,d.cts,tsbuildinfo}",
    // Native rebuilds happen before the files filter. Keep prebuilds, binaries,
    // helpers and licenses; only omit the upstream native source and test code.
    "!node_modules/node-pty/deps/winpty/src/**",
    "!node_modules/node-pty/lib/*.test.js",
    "!node_modules/node-pty/build/**/obj/**",
    "!node_modules/node-pty/build/**/*.{iobj,ipdb,tlog,vcxproj,filters,props,targets,sln}",
    "!apps/desktop/prod-resources/entitlements.mac*.plist",
  ];
  const dependencySourcemaps =
    input.dependencySourcemaps ??
    parseOptionalBooleanEnvValue(
      "SYNARA_DESKTOP_DEPENDENCY_SOURCEMAP",
      process.env.SYNARA_DESKTOP_DEPENDENCY_SOURCEMAP,
      false,
    );
  if (!dependencySourcemaps) {
    files.push("!node_modules/**/*.map");
    // node-pty's emitted JS maps reference the original TypeScript in src/.
    files.push("!node_modules/node-pty/src/**");
    files.push(
      ...COMPILED_DEPENDENCY_SOURCE_TREES.map(
        (name) => `!node_modules/${name}/src/**/*.{ts,tsx,mts,cts}`,
      ),
    );
  }
  if (
    input.platform === "linux" &&
    (input.linuxGlibc ??
      (process.platform === "linux" && isGlibcRuntime(process.report.getReport())))
  ) {
    // Electron's Linux release runs on glibc. The SDK resolves the glibc binary
    // first on these hosts; its musl fallback is ~200 MB and cannot run there.
    // Unknown/musl build hosts retain both packages rather than guessing.
    files.push("!node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl/**");
  }
  const unusedArtwork = {
    mac: ["app-icon-linux.png", "app-icon-windows.ico", "icon.ico"],
    linux: [
      "app-icon-macos.png",
      "app-icon-windows.ico",
      "icon.ico",
      "icon.icns",
      "dock-icon*.png",
    ],
    win: ["app-icon-linux.png", "app-icon-macos.png", "icon.png", "icon.icns", "dock-icon*.png"],
  } as const;
  files.push(
    ...unusedArtwork[input.platform].map((name) => `!apps/desktop/prod-resources/${name}`),
  );
  return files;
}
