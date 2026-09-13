import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Diagnostic only: never consumes test results to decide whether tests run.
export default class TimingReporter {
  modules = [];

  onTestModuleEnd(module) {
    const diagnostic = module.diagnostic();
    this.modules.push({
      path: module.relativeModuleId,
      state: module.state(),
      durationMs: diagnostic.duration,
      collectMs: diagnostic.collectDuration,
      setupMs: diagnostic.setupDuration,
      prepareMs: diagnostic.prepareDuration,
      environmentMs: diagnostic.environmentSetupDuration,
      tests: [...module.children.allTests()].map((test) => ({
        name: test.fullName,
        state: test.result().state,
        durationMs: test.diagnostic()?.duration ?? 0,
      })),
    });
  }

  onTestRunEnd() {
    const output = process.env.CI_TIMINGS_FILE;
    if (!output) throw new Error("CI_TIMINGS_FILE must name the timing report.");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      output,
      JSON.stringify(
        {
          source: process.env.GITHUB_SHA,
          platform: process.platform,
          arch: process.arch,
          modules: this.modules,
        },
        null,
        2,
      ) + "\n",
    );
  }
}
