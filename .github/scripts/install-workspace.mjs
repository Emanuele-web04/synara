// One dependency-closure policy for CI, native release builds and benchmarks.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function installArgs(profile = "full") {
  if (!["full", "product", "release", "device"].includes(profile)) {
    throw new Error(`Unknown workspace install profile: ${profile}`);
  }
  const args = ["install", "--frozen-lockfile"];
  // These two lanes already skip lifecycle scripts; validation lanes never do.
  if (profile === "release" || profile === "device") args.push("--ignore-scripts");
  if (profile !== "full") {
    args.push("--filter", "./");
    if (profile !== "device") {
      args.push("--filter", "@synara/cli...", "--filter", "@synara/desktop...");
    }
    // Ellipses include transitive workspace dependencies, not just directories.
    args.push("--filter", "@synara/scripts...");
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = installArgs(process.argv[2]);
  console.log(`Workspace install: bun ${args.join(" ")}`);
  const run = spawnSync("bun", args, { stdio: "inherit", timeout: 600_000 });
  if (run.error) console.error(run.error.message);
  process.exit(run.status ?? 1);
}
