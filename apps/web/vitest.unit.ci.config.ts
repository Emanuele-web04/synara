import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import {
  BUNDLED_DEPS_GUARD_ENV,
  bundledDepsGuard,
  bundledDepsOptimizer,
} from "./scripts/unit-test-deps";
import viteConfig from "./vite.config";

// ChatView.tsx dominates the hot-path compile time, so it is a separate file
// that runs beside the rest of the list.
const compilerTests = [
  "src/components/ChatView.compiler.test.ts",
  "src/components/chatHotPath.compiler.test.ts",
];
const localTimeTest = "src/components/inbox/inbox.logic.test.ts";

// Effect and @synara/contracts load once per run from a pre-bundle instead of
// module by module in every test file. The compiler project runs in the Core
// lane and keeps its previous loading.
const bundledDeps = {
  plugins: [bundledDepsGuard()],
  deps: { optimizer: { ssr: bundledDepsOptimizer() } },
  env: { [BUNDLED_DEPS_GUARD_ENV]: "1" },
};

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: [],
      projects: [
        {
          extends: true,
          plugins: bundledDeps.plugins,
          test: {
            deps: bundledDeps.deps,
            env: bundledDeps.env,
            name: "web",
            include: configDefaults.include,
            exclude: [...configDefaults.exclude, localTimeTest, ...compilerTests],
            pool: "threads",
          },
        },
        {
          extends: true,
          plugins: bundledDeps.plugins,
          test: {
            deps: bundledDeps.deps,
            env: bundledDeps.env,
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
