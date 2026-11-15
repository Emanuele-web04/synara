import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BaseSequencer, createVitest, type TestSpecification } from "vitest/node";

const serverRoot = fileURLToPath(new URL("../apps/server/", import.meta.url));
const count = 3;
// Expected placement must not come from the config being checked.
const expectedPins: Record<string, number> = {
  "src/orchestration/Layers/ProviderCommandReactor.test.ts": 2,
  "src/accountLiveActivityReporter.test.ts": 2,
};

const name = (file: TestSpecification) => relative(serverRoot, file.moduleId).replaceAll("\\", "/");

async function collectShard(index: number) {
  const vitest = await createVitest("test", {
    root: serverRoot,
    config: "vitest.config.ts",
    watch: false,
    shard: `${index}/${count}`,
  });
  try {
    const files = await vitest.globTestSpecifications();
    const Sequencer = vitest.config.sequence.sequencer;
    const configured = await new Sequencer(vitest).shard(files);
    const native = await new BaseSequencer(vitest).shard(files);
    // Glob order is not stable between instances; shard assignment does not depend on it.
    return {
      all: files.map(name).toSorted(),
      configured: configured.map(name).toSorted(),
      native: native.map(name).toSorted(),
    };
  } finally {
    await vitest.close();
  }
}

describe("server CI shards", () => {
  it("runs every server test file on exactly one shard with only the pinned files moved", async () => {
    const shards = [];
    for (let index = 1; index <= count; index++) shards.push(await collectShard(index));
    const all = shards[0]!.all;
    expect(all.length).toBeGreaterThan(0);
    for (const shard of shards) expect(shard.all).toEqual(all);

    const owners = new Map<string, number[]>();
    shards.forEach((shard, position) => {
      for (const file of shard.configured)
        owners.set(file, [...(owners.get(file) ?? []), position + 1]);
    });
    expect([...owners.keys()].toSorted()).toEqual(all);
    for (const [file, shardIndexes] of owners) expect(shardIndexes, file).toHaveLength(1);

    for (const [file, index] of Object.entries(expectedPins)) {
      expect(all, `${file} must still exist`).toContain(file);
      expect(owners.get(file), file).toEqual([index]);
    }
    shards.forEach((shard, position) => {
      const unpinnedNative = shard.native.filter((file) => !(file in expectedPins));
      const unpinnedConfigured = shard.configured.filter((file) => !(file in expectedPins));
      expect(unpinnedConfigured, `shard ${position + 1}`).toEqual(unpinnedNative);
    });
  }, 120_000);
});
