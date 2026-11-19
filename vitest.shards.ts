import { relative, sep } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

export function createPinnedShardSequencer(
  pinsByCount: Readonly<Record<number, Readonly<Record<string, number>>>>,
): typeof BaseSequencer {
  return class extends BaseSequencer {
    override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
      const { config } = this.ctx;
      const { index, count } = config.shard!;
      const pins = pinsByCount[count];
      const native = await super.shard(files);
      if (!pins) return native;

      const pinnedShard = (file: TestSpecification) =>
        pins[relative(config.root, file.moduleId).split(sep).join("/")];
      // Replace the native placement only for pinned files, once per file.
      return [
        ...native.filter((file) => pinnedShard(file) === undefined),
        ...files.filter((file) => pinnedShard(file) === index),
      ];
    }
  };
}
