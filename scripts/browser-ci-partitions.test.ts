import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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

// Resolve the same configuration as each of the two GitHub browser steps.
async function collectChatSlices() {
  const slices: Awaited<ReturnType<typeof collectPartitions>> = [];
  try {
    for (const slice of ["a", "b"]) {
      vi.stubEnv("VITEST_BROWSER_CHAT_SLICE", slice);
      slices.push(...(await collectPartitions("vitest.browser.ci.config.ts")));
    }
  } finally {
    vi.unstubAllEnvs();
  }
  return slices.filter(
    ({ project }) =>
      project === "chat-projects (chromium)" || project === "chat-workflows (chromium)",
  );
}

describe("browser CI partitions", () => {
  it("keeps every stable file and partitions ChatView without duplicating other suites", async () => {
    const stable = await collectPartitions("vitest.browser.stable.config.ts");
    const partitions = await collectPartitions("vitest.browser.ci.config.ts");
    const pairedPartitions = await collectChatSlices();
    const stableFiles = new Set(stable.map(({ file }) => file));

    expect(stableFiles.size).toBeGreaterThan(0);
    expect(new Set(partitions.map(({ file }) => file))).toEqual(stableFiles);
    for (const file of stableFiles) {
      const owners = partitions.filter((partition) => partition.file === file);
      if (file.endsWith("/ChatView.browser.tsx")) {
        const ciOwners = [
          ...owners.filter(({ project }) => project === "chat-follow (chromium)"),
          ...pairedPartitions.filter((partition) => partition.file === file),
        ];
        expect(owners.map(({ project }) => project).sort()).toEqual([
          "chat-follow (chromium)",
          "chat-projects (chromium)",
          "chat-workflows (chromium)",
        ]);
        const geometry = "ChatView transcript geometry (full app)";
        for (const [name, lane] of [
          [`${geometry} renders the active thread title`, "chat-workflows"],
          [`${geometry} restores streaming follow after wheel`, "chat-follow"],
          ["keeps scroll anchor stable", "chat-follow"],
          ["renders tool activity", "chat-follow"],
          // Follow keywords keep precedence over the projects group.
          [
            `${geometry} keeps subagents out of the sidebar while navigating ('click', scroll takeover: false)`,
            "chat-follow",
          ],
          ["creates a project", "chat-projects"],
          ["new worktree", "chat-projects"],
          ["approval already answered", "chat-projects"],
          ["queued composer request", "chat-projects"],
          [`${geometry} keeps sidebar shortcut hints clear of row content`, "chat-projects"],
          [
            `${geometry} provider handoff destination hands the thread off before sending`,
            "chat-projects",
          ],
          ["a newly added case", "chat-workflows"],
        ] as const) {
          // Expected membership must not come from the config being checked.
          const selected = owners.filter(({ pattern }) => pattern?.test(name));
          expect(
            selected.map(({ project }) => project),
            name,
          ).toEqual([`${lane} (chromium)`]);
          expect(
            ciOwners.filter(({ pattern }) => pattern?.test(name)).map(({ project }) => project),
            name,
          ).toEqual([`${lane} (chromium)`]);
          const quarantined = `[geometry:linux] ${name}`;
          expect(
            owners.filter(({ pattern }) => pattern?.test(quarantined)),
            quarantined,
          ).toHaveLength(0);
          expect(ciOwners.filter(({ pattern }) => pattern?.test(quarantined))).toHaveLength(0);
        }
      } else {
        expect(owners.map(({ project }) => project)).toEqual(["components (chromium)"]);
        expect(owners[0]!.pattern).toEqual(stable[0]!.pattern);
      }
      expect(owners.every(({ fileParallelism }) => fileParallelism === false)).toBe(true);
    }
  }, 120_000);
});
