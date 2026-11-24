// FILE: desktop-bundle-files.ts
// Purpose: Exclude non-runtime files from desktop artifacts without changing the staged install.
// Layer: Release/build helper

const DIAGNOSTIC_FILES = [
  "!node_modules/**/*.{js,mjs,cjs,ts,mts,cts}.map",
  "!node_modules/**/*.{d.mts,d.cts,tsbuildinfo}",
  // These packages execute their compiled JS exports. Keep arbitrary dependency
  // sources: extension loaders and native helpers can legitimately need them.
  // Remove only TypeScript, retaining vendored licenses and other source assets.
  "!node_modules/effect/src/**/*.ts",
  "!node_modules/@effect/{platform-node,platform-node-shared,sql-sqlite-bun}/src/**/*.ts",
  "!node_modules/openai/src/**/*.ts",
  "!node_modules/@anthropic-ai/sdk/src/**/*.ts",
  "!node_modules/**/node_modules/@anthropic-ai/sdk/src/**/*.ts",
  "!node_modules/zod/src/**/*.ts",
  "!node_modules/**/node_modules/zod/src/**/*.ts",
  "!node_modules/{tldts,tldts-core,tldts-experimental,smol-toml,mime,eventsource,eventsource-parser}/src/**/*.ts",
  "!node_modules/tough-cookie/node_modules/tldts/src/**/*.ts",
  "!node_modules/tough-cookie/node_modules/tldts/node_modules/tldts-core/src/**/*.ts",
  "!node_modules/@noble/{hashes,curves,ciphers}/src/**/*.ts",
  "!node_modules/**/node_modules/@noble/hashes/src/**/*.ts",
] as const;

const UNUSED_DEPENDENCY_RUNTIME_FILES = [
  // BetterWright optional/debug payloads unused by Synara:
  // - patchright-core is only loaded for stealthRuntimeFix (unsupported on hostTarget).
  // - playwright-core/lib/vite contains HTML report / trace viewer / recorder web UIs.
  // - @ghostery/* is lazy-imported by betterwright/dist/src/ad-blocker.js only when adBlock: true;
  //   Synara explicitly passes adBlock: false on every BetterWright instance.
  "!node_modules/patchright-core/**",
  "!node_modules/playwright-core/lib/vite/**",
  "!node_modules/@ghostery/**",
  "!node_modules/betterwright/docs/**",
  // @earendil-works/pi-coding-agent ships a standalone CLI bundle (dist/bundle) and
  // markdown docs + screenshots (docs/) that are not referenced by its library entrypoint.
  "!node_modules/@earendil-works/pi-coding-agent/dist/bundle/**",
  "!node_modules/@earendil-works/pi-coding-agent/docs/**",
  // EditorLanguageService only imports typescript/lib/typescript.js and lib.*.d.ts
  // (English diagnostics are embedded; CLI compiler and localized catalogs are unused).
  "!node_modules/typescript/bin/**",
  "!node_modules/typescript/lib/tsc.js",
  "!node_modules/typescript/lib/_tsc.js",
  "!node_modules/typescript/lib/{cs,de,es,fr,it,ja,ko,pl,pt-br,ru,tr,zh-cn,zh-tw}/**",
  // Effect bundles full Scalar and Swagger HTML/JS UIs that Synara never serves.
  "!node_modules/effect/dist/unstable/httpapi/internal/httpApiScalar.js",
  "!node_modules/effect/dist/unstable/httpapi/internal/httpApiSwagger.js",
  // Browser-only SDK bundle; Node runtime loads sdk.mjs.
  "!node_modules/@anthropic-ai/claude-agent-sdk/browser-sdk.js",
  // @google/genai resolves exports["."].node -> dist/node/index.{mjs,cjs} under Node;
  // browser, non-node fallback, and vertex_internal bundles are never loaded.
  "!node_modules/@google/genai/dist/web/**",
  "!node_modules/@google/genai/dist/index.{cjs,mjs}",
  "!node_modules/@google/genai/dist/vertex_internal/**",
  // fetch-blob/streams.cjs only references dist/ponyfill.es2018.js as a fallback;
  // drop redundant ES5/ES6/polyfill/minified variants.
  "!node_modules/web-streams-polyfill/dist/{polyfill,polyfill.es6,polyfill.es2018,polyfill.min,polyfill.es6.min,polyfill.es2018.min,ponyfill,ponyfill.es6}.{js,mjs}",
  // Undici markdown documentation trees.
  "!node_modules/undici/docs/**",
  "!node_modules/**/node_modules/undici/docs/**",
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
  const files = [
    "**/*",
    "!apps/desktop/resources/cloudflared/**",
    "!apps/desktop/prod-resources/cloudflared/**",
    // Desktop Electron loads static assets over 127.0.0.1 loopback (and Synara Remote
    // compresses at the Cloudflare Tunnel edge). Shipping precompressed .gz/.br sidecars
    // inside app.asar adds ~14.7 MB of incompressible bytes directly to every DMG/ZIP
    // and copies 1,700+ extra files into the static snapshot; apps/server/src/http.ts
    // serves the uncompressed assets directly when sidecars are absent.
    "!apps/server/dist/client/**/*.{gz,br}",
    ...UNUSED_DEPENDENCY_RUNTIME_FILES,
  ];
  if (!options.diagnostics) files.push(...DIAGNOSTIC_FILES);

  // node-pty is rebuilt before packaging. Its platform prebuilds are not
  // interchangeable; retain both same-platform architectures for universal Mac.
  if (platform !== "mac") files.push("!node_modules/node-pty/prebuilds/darwin-*/**");
  if (platform !== "win") files.push("!node_modules/node-pty/prebuilds/win32-*/**");
  files.push("!node_modules/node-pty/lib/*.test.js");
  // MSVC leaves incremental-link inputs and build logs next to the rebuilt
  // addon. These are build products, not DLLs, executables, or native addons.
  files.push(
    "!node_modules/node-pty/build/**/*.{iobj,ipdb,tlog,vcxproj,filters,recipe,lastbuildstate,exp,lib}",
  );

  // All icon preferences for the target OS and the menu fallback remain intact.
  // The dock-icon glob also covers the beta dock file, so mac keeps
  // dock-icon-beta.png while other platforms drop it; the beta linux/windows
  // picker files follow their flavor-neutral siblings below.
  const resources = "!apps/desktop/prod-resources/";
  files.push(`${resources}entitlements.mac*.plist`);
  if (platform !== "mac") {
    files.push(
      `${resources}app-icon-macos.png`,
      `${resources}dock-icon*.png`,
      `${resources}icon.icns`,
    );
  }
  if (platform !== "linux")
    files.push(
      `${resources}app-icon-linux.png`,
      `${resources}app-icon-beta-linux.png`,
      `${resources}app-icon-default-linux.png`,
    );
  if (platform !== "win")
    files.push(
      `${resources}app-icon-windows.ico`,
      `${resources}app-icon-beta-windows.ico`,
      `${resources}app-icon-default-windows.ico`,
      `${resources}icon.ico`,
    );

  // The SDK selects the glibc executable first on a glibc host. The musl
  // executable needs a different loader and cannot be its working fallback.
  // Unknown/non-glibc build hosts retain both variants instead of guessing.
  if (platform === "linux" && options.linuxGlibc) {
    files.push("!node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl/**");
  }
  return files;
}
