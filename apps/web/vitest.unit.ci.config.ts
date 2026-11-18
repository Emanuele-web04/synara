import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

// ChatView.tsx dominates the hot-path compile time, so it is a separate file
// that runs beside the rest of the list.
const compilerTests = [
  "src/components/ChatView.compiler.test.ts",
  "src/components/chatHotPath.compiler.test.ts",
];
const localTimeTest = "src/components/inbox/inbox.logic.test.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: [],
      projects: [
        {
          extends: true,
          test: {
            name: "web",
            include: configDefaults.include,
            exclude: [...configDefaults.exclude, localTimeTest, ...compilerTests],
            pool: "threads",
          },
        },
        {
          extends: true,
          test: {
            // A fork applies runtime TZ changes to Date for the DST assertions.
            name: "web-local-time",
            include: [localTimeTest],
            pool: "forks",
          },
        },
        {
          extends: true,
          test: {
            name: "web-compiler",
            include: compilerTests,
            pool: "threads",
          },
        },
      ],
    },
  }),
);
