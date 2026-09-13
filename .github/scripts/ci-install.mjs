// Keep installation profiles dependency-aware; an uncertain graph installs more.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readGraph } from "./ci-plan.mjs";

export function selectInstall(profile, graph, rootManifest) {
  if (!["full", "runtime", "device"].includes(profile)) {
    throw new Error(`Unknown installation profile: ${profile}`);
  }
  const rootDependencies = Object.keys({
    ...rootManifest.dependencies,
    ...rootManifest.devDependencies,
    ...rootManifest.peerDependencies,
    ...rootManifest.optionalDependencies,
  });
  if (profile === "runtime") {
    const marketing = "@synara/marketing";
    // Exclusions override Bun's dependency selection. Never exclude a package
    // that another installed workspace (or the root) has begun to consume.
    const consumer = Object.entries(graph).some(
      ([name, dependencies]) => name !== marketing && dependencies.includes(marketing),
    );
    if (!consumer && !rootDependencies.includes(marketing)) {
      return { profile, args: ["--filter", `!${marketing}`] };
    }
  }
  if (profile === "device") {
    // Bun includes forward workspace dependencies; the probe imports shared
    // device types and Node-only helperSandbox source from the server tree.
    if (!Object.hasOwn(graph, "@synara/scripts")) throw new Error("Device workspace missing");
    return { profile, args: ["--filter", "@synara/scripts..."] };
  }
  return { profile: "full", args: [] };
}

export function installPlan(profile, root) {
  // Reject typos even when the graph is unavailable.
  if (!["full", "runtime", "device"].includes(profile)) {
    throw new Error(`Unknown installation profile: ${profile}`);
  }
  if (profile === "full") return { profile, args: [] };
  try {
    return selectInstall(
      profile,
      readGraph(root),
      JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")),
    );
  } catch (error) {
    console.warn(`Install graph uncertainty; using full workspace: ${error.message}`);
    return { profile: "full", args: [] };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [profile = "full", ...options] = process.argv.slice(2);
  if (options.some((option) => !["--plan", "--ignore-scripts"].includes(option))) {
    throw new Error("Only --plan and --ignore-scripts are supported.");
  }
  const plan = installPlan(profile, process.cwd());
  if (options.includes("--plan")) {
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `profile=${plan.profile}\n`);
    console.log(JSON.stringify(plan));
  } else {
    const args = ["install", "--frozen-lockfile", ...plan.args];
    if (options.includes("--ignore-scripts")) args.push("--ignore-scripts");
    console.log(`Installation profile: ${plan.profile}`);
    const child = spawnSync("bun", args, { stdio: "inherit", shell: false });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  }
}
