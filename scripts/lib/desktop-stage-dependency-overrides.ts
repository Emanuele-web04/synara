// FILE: desktop-stage-dependency-overrides.ts
// Purpose: Keeps staged desktop installs working around published packages with unresolved catalog deps.
// Layer: Release/build script support

export const DESKTOP_STAGE_DEPENDENCY_OVERRIDES = {
  // 1.2.9 declares a dependency on @pierre/theming@0.0.1 which is not published
  // to npm (404), breaking fresh staged installs. Pin the last installable
  // version until upstream ships a fixed release.
  "@pierre/diffs": "1.2.8",
  "@pierre/theme": "1.0.3",
  diff: "8.0.3",
  "hast-util-to-html": "9.0.5",
  lru_map: "0.4.1",
} as const satisfies Record<string, string>;
