import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createVitest, type TestSpecification } from "vitest/node";

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
      isolate: specification.project.config.browser.isolate,
      maxWorkers: specification.project.config.maxWorkers,
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
      project === "chat-follow (chromium)" ||
      project === "chat-projects (chromium)" ||
      project === "chat-workflows (chromium)",
  );
}

async function collectComponentShard(shard: string) {
  const vitest = await createVitest("test", {
    root: webRoot,
    config: "vitest.browser.ci.config.ts",
    watch: false,
    shard,
  });
  try {
    const files = (await vitest.globTestSpecifications()).filter(
      ({ project }) => project.name === "components (chromium)",
    );
    const name = ({ moduleId }: TestSpecification) =>
      relative(webRoot, moduleId).replaceAll("\\", "/");
    const Sequencer = vitest.config.sequence.sequencer;
    return {
      all: files.map(name).toSorted(),
      configured: (await new Sequencer(vitest).shard(files)).map(name).toSorted(),
    };
  } finally {
    await vitest.close();
  }
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
        const ciOwners = pairedPartitions.filter((partition) => partition.file === file);
        expect(owners.map(({ project }) => project).sort()).toEqual([
          "chat-follow (chromium)",
          "chat-projects (chromium)",
          "chat-workflows (chromium)",
        ]);
        expect(owners.every(({ fileParallelism }) => fileParallelism === false)).toBe(true);
        const geometry = "ChatView transcript geometry (full app)";
        for (const [name, lane] of [
          [`${geometry} renders the active thread title`, "chat-workflows"],
          [`${geometry} restores streaming follow after wheel`, "chat-follow"],
          ["keeps scroll anchor stable", "chat-follow"],
          ["renders tool activity", "chat-follow"],
          ["does not rearm detached reading for non-message activity", "chat-follow"],
          ["keeps the surviving non-route chat mounted when a split collapses", "chat-follow"],
          ["closes only the inactive ordinary source pane", "chat-follow"],
          // Follow keywords keep precedence over the projects group.
          [
            `${geometry} keeps subagents out of the sidebar while navigating ('click', scroll takeover: false)`,
            "chat-follow",
          ],
          ["creates a project", "chat-projects"],
          ["new worktree", "chat-projects"],
          ["approval already answered", "chat-projects"],
          ["queued composer request", "chat-projects"],
          ["cancels a pending editor chat tab switch after inflight", "chat-projects"],
          ["switches horizontal tabs without blanking the header or composer", "chat-projects"],
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
        expect(owners[0]).toMatchObject({ fileParallelism: true, isolate: true, maxWorkers: 3 });
      }
    }
  }, 120_000);

  it("places all component files exactly once across three CI jobs", async () => {
    const shards = [];
    for (const shard of ["1/3", "2/3", "3/3"]) {
      shards.push(await collectComponentShard(shard));
    }
    const all = shards[0]!.all;
    expect(all.length).toBeGreaterThan(0);
    expect(shards.flatMap(({ configured }) => configured).toSorted()).toEqual(all);

    for (const { all: collected, configured } of shards) {
      expect(collected).toEqual(all);
      expect(configured.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
