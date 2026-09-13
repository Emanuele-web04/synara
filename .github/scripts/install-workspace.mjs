// One frozen installation contract for CI and native artifact/device jobs.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readGraph } from "./ci-plan.mjs";

const seeds = {
  full: [],
  runtime: ["@synara/cli", "@synara/desktop", "@synara/scripts"],
  tools: ["@synara/scripts"],
};

export function installArguments(profile, graph, ignoreScripts = false) {
  if (!Object.hasOwn(seeds, profile)) throw new Error(`Unknown installation profile: ${profile}`);
  const args = ["install", "--frozen-lockfile"];
  if (ignoreScripts) args.push("--ignore-scripts");
  if (profile === "full" || graph === null) return args;
  const selected = new Set();
  const pending = [...seeds[profile]];
  while (pending.length) {
    const name = pending.pop();
    if (selected.has(name)) continue;
    if (!Object.hasOwn(graph, name)) throw new Error(`Missing workspace: ${name}`);
    selected.add(name);
    pending.push(...graph[name]);
  }
  // Include the root toolchain and the complete dependency closure, including
  // dev/peer/optional dependencies and desktop's implicit packaged CLI edge.
  args.push("--filter", "./");
  for (const name of [...selected].sort()) args.push("--filter", name);
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [profile = "full", ...options] = process.argv.slice(2);
  if (options.some((option) => option !== "--ignore-scripts")) {
    throw new Error("Only --ignore-scripts is accepted; frozen installation is mandatory.");
  }
  let graph = null;
  if (profile !== "full") {
    try {
      graph = readGraph(process.cwd());
    } catch (error) {
      console.warn(
        `Workspace inventory changed; falling back to full installation: ${error.message}`,
      );
    }
  }
  const args = installArguments(profile, graph, options.includes("--ignore-scripts"));
  console.log(`bun ${args.join(" ")}`);
  const result = spawnSync("bun", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
