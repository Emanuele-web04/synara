// FILE: desktop-stage-dependency-overrides.ts
// Purpose: Keeps staged desktop installs working around published packages with unresolved catalog deps.
// Layer: Release/build script support

export const DESKTOP_STAGE_DEPENDENCY_OVERRIDES = {
  "@pierre/theme": "1.0.3",
  diff: "8.0.3",
  "hast-util-to-html": "9.0.5",
  lru_map: "0.4.1",
} as const satisfies Record<string, string>;
