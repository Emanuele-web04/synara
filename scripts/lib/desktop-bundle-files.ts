// FILE: desktop-bundle-files.ts
// Purpose: Exclude non-runtime files from desktop artifacts without changing the staged install.
// Layer: Release/build helper

const DIAGNOSTIC_FILES = [
  "!node_modules/**/*.{js,mjs,cjs,ts,mts,cts}.map",
  "!node_modules/**/*.{d.mts,d.cts,tsbuildinfo}",
  // These packages execute their compiled JS exports. Keep arbitrary dependency
  // sources: extension loaders and native helpers can legitimately need them.
  "!node_modules/effect/src/**",
  "!node_modules/@effect/{platform-node,platform-node-shared,sql-sqlite-bun}/src/**",
  "!node_modules/openai/src/**",
  "!node_modules/@anthropic-ai/sdk/src/**",
] as const;

export function preserveDependencyDiagnostics(env: NodeJS.ProcessEnv): boolean {
  return [
    env.SYNARA_WEB_SOURCEMAP,
    env.SYNARA_SERVER_SOURCEMAP,
    env.SYNARA_DESKTOP_SOURCEMAP,
  ].some((value) => ["1", "true", "hidden"].includes(value?.trim().toLowerCase() ?? ""));
}

export function createDesktopBundleFilePatterns(
  platform: "mac" | "linux" | "win",
  options: { readonly diagnostics?: boolean; readonly linuxGlibc?: boolean } = {},
): string[] {
  const files = ["**/*"];
  if (!options.diagnostics) files.push(...DIAGNOSTIC_FILES);

  // node-pty is rebuilt before packaging. Its platform prebuilds are not
  // interchangeable; retain both same-platform architectures for universal Mac.
  if (platform !== "mac") files.push("!node_modules/node-pty/prebuilds/darwin-*/**");
  if (platform !== "win") files.push("!node_modules/node-pty/prebuilds/win32-*/**");
  files.push("!node_modules/node-pty/lib/*.test.js");

  // All icon preferences for the target OS and the menu fallback remain intact.
  // Build resources (signing entitlements / installer icons) are left untouched;
  // only their otherwise redundant runtime copies are filtered here.
  const resources = "!apps/desktop/prod-resources/";
  files.push(`${resources}entitlements.mac*.plist`);
  if (platform !== "mac") {
    files.push(
      `${resources}app-icon-macos.png`,
      `${resources}dock-icon*.png`,
      `${resources}icon.icns`,
    );
  }
  if (platform !== "linux") files.push(`${resources}app-icon-linux.png`);
  if (platform !== "win") files.push(`${resources}app-icon-windows.ico`, `${resources}icon.ico`);

  // The SDK selects the glibc executable first on a glibc host. The musl
  // executable needs a different loader and cannot be its working fallback.
  // Unknown/non-glibc build hosts retain both variants instead of guessing.
  if (platform === "linux" && options.linuxGlibc) {
    files.push("!node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl/**");
  }
  return files;
}
