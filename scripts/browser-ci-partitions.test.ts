import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";

const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));

async function collectPartitions(config: string) {
  const vitest = await createVitest("test", { root: webRoot, config, watch: false });
  try {
    const specifications = await vitest.globTestSpecifications();
    return specifications.map((specification) => ({
      file: specification.moduleId,
      project: specification.project.name,
      // Vitest applies the root pattern as a runtime override of each project.
      pattern:
        vitest.getGlobalTestNamePattern() ?? specification.project.serializedConfig.testNamePattern,
      fileParallelism: specification.project.config.browser.fileParallelism,
    }));
  } finally {
    await vitest.close();
  }
}

describe("browser CI partitions", () => {
  it("keeps every stable file and partitions ChatView without duplicating other suites", async () => {
    const stable = await collectPartitions("vitest.browser.stable.config.ts");
    const partitions = await collectPartitions("vitest.browser.ci.config.ts");
    const stableFiles = new Set(stable.map(({ file }) => file));

    expect(stableFiles.size).toBeGreaterThan(0);
    expect(new Set(partitions.map(({ file }) => file))).toEqual(stableFiles);
    for (const file of stableFiles) {
      const owners = partitions.filter((partition) => partition.file === file);
      if (file.endsWith("/ChatView.browser.tsx")) {
        expect(owners.map(({ project }) => project).sort()).toEqual([
          "chat-follow (chromium)",
          "chat-workflows (chromium)",
        ]);
        for (const name of [
          "ChatView transcript geometry (full app) renders the active thread title",
          "ChatView transcript geometry (full app) restores streaming follow after wheel",
          "a newly added case",
          "a newly added restores streaming follow case",
          "[geometry:linux] a quarantined case",
          "[geometry:linux] restores streaming follow",
        ]) {
          const selected = owners.filter(({ pattern }) => pattern?.test(name));
          expect(selected.length, name).toBe(stable[0]!.pattern!.test(name) ? 1 : 0);
        }
      } else {
        expect(owners.map(({ project }) => project)).toEqual(["components (chromium)"]);
        expect(owners[0]!.pattern).toEqual(stable[0]!.pattern);
      }
      expect(owners.every(({ fileParallelism }) => fileParallelism === false)).toBe(true);
    }
  }, 30_000);
});
