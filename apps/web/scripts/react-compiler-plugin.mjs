// FILE: react-compiler-plugin.mjs
// Purpose: The one definition of the React Compiler Babel plugin, shared by
//          vite.config.ts and the transform workers so both compile with the
//          same options. Plain .mjs: worker threads load it without a build.
// Layer: Web build config

import babel from "@rolldown/plugin-babel";
import { reactCompilerPreset } from "@vitejs/plugin-react";

export function createReactCompilerPlugin() {
  return babel({
    // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
    // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
    // whereas the previous version of the plugin parsed all files with a .ts extension.
    // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [reactCompilerPreset()],
  });
}
