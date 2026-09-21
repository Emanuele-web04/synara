const DIAGNOSTIC_FILES = [
  "!node_modules/**/*.{js,mjs,cjs,ts,mts,cts}.map",
  "!node_modules/**/*.{d.mts,d.cts,tsbuildinfo}",
  // these packages execute their compiled JS exports — remove only TypeScript, keep vendored licenses and sources
  "!node_modules/effect/src/**/*.ts",
  "!node_modules/@effect/{platform-node,platform-node-shared,sql-sqlite-bun}/src/**/*.ts",
  "!node_modules/openai/src/**/*.ts",
  "!node_modules/@anthropic-ai/sdk/src/**/*.ts",
] as const;

export function preserveDependencyDiagnostics(env: NodeJS.ProcessEnv): boolean {
  return [env.SYNARA_WEB_SOURCEMAP, env.SYNARA_SERVER_SOURCEMAP, env.SYNARA_DESKTOP_SOURCEMAP].some(
    (value) => ["1", "true", "hidden"].includes(value?.trim().toLowerCase() ?? ""),
  );
}

export function createDesktopBundleFilePatterns(
  platform: "mac" | "linux" | "win",
  options: { readonly diagnostics?: boolean; readonly linuxGlibc?: boolean } = {},
): string[] {
  const files = ["**/*"];
  if (!options.diagnostics) files.push(...DIAGNOSTIC_FILES);

  // node-pty is rebuilt before packaging and its prebuilds aren't interchangeable — keep both same-platform arches for the universal Mac
  if (platform !== "mac") files.push("!node_modules/node-pty/prebuilds/darwin-*/**");
  if (platform !== "win") files.push("!node_modules/node-pty/prebuilds/win32-*/**");
  files.push("!node_modules/node-pty/lib/*.test.js");
  // MSVC incremental-link inputs and build logs — build products, not runtime files
  files.push(
    "!node_modules/node-pty/build/**/*.{iobj,ipdb,tlog,vcxproj,filters,recipe,lastbuildstate,exp,lib}",
  );

  // icon preferences and the menu fallback stay intact; only redundant runtime copies are filtered
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

  // the SDK picks the glibc executable first; musl needs a different loader, and unknown hosts keep both variants
  if (platform === "linux" && options.linuxGlibc) {
    files.push("!node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl/**");
  }
  return files;
}
