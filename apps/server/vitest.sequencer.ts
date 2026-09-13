import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

import { balance } from "../../.github/scripts/ci-balance";
import timings from "./vitest.ci.timings.json";

export default class TimedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    if (shard.index < 1 || shard.index > shard.count) throw new Error("Invalid shard index");
    return balance(
      files,
      shard.count,
      (file) => relative(this.ctx.config.root, file.moduleId).replaceAll("\\", "/"),
      timings.weights,
      timings.fallbackMs,
    )[shard.index - 1]!;
  }
}
