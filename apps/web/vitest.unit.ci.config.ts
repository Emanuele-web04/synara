import { fileURLToPath } from "node:url";
import { normalizePath, type Plugin } from "vite";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import type { TestSpecification } from "vitest/node";

import viteConfig from "./vite.config";

const compilerGuard = normalizePath(
  fileURLToPath(new URL("./src/components/chatHotPath.compiler.test.ts", import.meta.url)),
);
const localTimeTest = "src/components/inbox/inbox.logic.test.ts";

const startCompilerFirst: Plugin = {
  name: "synara-web-ci-compiler-first",
  configureVitest({ vitest }) {
    // Start the long compiler guard while other workers can drain the suite.
    // Keep Vitest's normal sharding and seeded shuffle for every other file.
    const Sequencer = vitest.config.sequence.sequencer;
    vitest.config.sequence.sequencer = class extends Sequencer {
      override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
        const ordered = await super.sort(files);
        const compilerIndex = ordered.findIndex(
          ({ moduleId }) => normalizePath(moduleId) === compilerGuard,
        );
        if (compilerIndex > 0) {
          ordered.unshift(...ordered.splice(compilerIndex, 1));
        }
        return ordered;
      }
    };
  },
};

export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [startCompilerFirst],
    test: {
      include: [],
      projects: [
        {
          extends: true,
          test: {
            name: "web",
            include: configDefaults.include,
            exclude: [...configDefaults.exclude, localTimeTest],
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
      ],
    },
  }),
);
