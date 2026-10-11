import { availableParallelism, totalmem, platform, arch, release } from "node:os";
console.log(
  JSON.stringify({
    event: "build-runner",
    at: new Date().toISOString(),
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpuCount: availableParallelism(),
    memoryGiB: totalmem() / 1024 ** 3,
    node: process.version,
    runnerImage: process.env.ImageOS,
    runnerImageVersion: process.env.ImageVersion,
  }),
);
