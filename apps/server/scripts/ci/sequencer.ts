import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

import { balance } from "./balance.ts";

// Timing data only schedules discovered files; it never selects tests to omit.
// BaseSequencer still owns ordering within each shard and all unsharded runs.
export default class TimingSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    try {
      const data: { defaultSeconds: number; seconds: Record<string, number> } = JSON.parse(
        readFileSync(new URL("./durations.json", import.meta.url), "utf8"),
      );
      const path = (file: TestSpecification) =>
        relative(this.ctx.config.root, file.moduleId).replaceAll("\\", "/");
      const bins = balance(
        files,
        shard.count,
        (file) => `${file.project.name}:${path(file)}`,
        (file) => data.seconds[path(file)] ?? data.defaultSeconds,
      );
      const selected = bins[shard.index - 1];
      if (!selected) throw new Error("Invalid shard index");
      return selected;
    } catch (error) {
      console.warn("Timing data unavailable; using Vitest's complete default partition.", error);
      return super.shard(files);
    }
  }
}
