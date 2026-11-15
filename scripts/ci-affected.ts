// FILE: ci-affected.ts
// Purpose: Decides which CI lanes a pull request can affect. Pull requests run
//          only those lanes; merge-queue runs and pushes always run every lane.
// Layer: `changes` job in .github/workflows/ci.yml.
// Depends on: git history back to the base (blobless full clone) and
//             `turbo ls --affected` for the workspace dependency graph.
// Usage: node scripts/ci-affected.ts <event> <base sha> <head sha>
//        Writes `<lane>=true|false` lines to $GITHUB_OUTPUT (or stdout).

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LANES = ["core", "web", "server", "build", "windows"] as const;
export type Lane = (typeof LANES)[number];

/** Workspace packages whose change requires each lane. */
export const LANE_PACKAGES: Readonly<Record<Lane, readonly string[]>> = {
  core: [
    "@synara/contracts",
    "@synara/shared",
    "@synara/scripts",
    "@synara/desktop",
    "@synara/analytics",
  ],
  web: ["@synara/web"],
  server: ["@synara/cli"],
  build: ["@synara/desktop", "@synara/cli", "@synara/web", "@synara/analytics"],
  windows: ["@synara/shared", "@synara/cli", "@synara/desktop"],
};

/**
 * Files outside any workspace package select every lane: root config, the
 * lockfile, patches, CI itself. Turbo does not map `.github/**` to a package.
 */
const GLOBAL = [
  /^\.github\//,
  /^\.githooks\//,
  /^patches\//,
  /^[^/]+(?<!\.md)$/, // root files except prose: package.json, bun.lock, turbo.json, tsconfig*.json …
];

/**
 * Undeclared dependencies that Turbo's package graph cannot see: the server
 * compiles and runs `scripts/lib` sources (apps/server/tsconfig.json includes
 * ../../scripts/lib) without depending on @synara/scripts.
 */
const EXTRA: readonly { readonly pattern: RegExp; readonly lanes: readonly Lane[] }[] = [
  { pattern: /^scripts\/lib\//, lanes: ["server", "build"] },
];

export type Selection = Record<Lane, boolean>;

const all = (value: boolean): Selection =>
  Object.fromEntries(LANES.map((lane) => [lane, value])) as Selection;

export function selectLanes(
  event: string,
  changedFiles: readonly string[],
  affectedPackages: readonly string[],
): Selection {
  // Only pull requests narrow. The merge queue and main run everything.
  if (event !== "pull_request") return all(true);
  if (changedFiles.some((file) => GLOBAL.some((pattern) => pattern.test(file)))) return all(true);
  const selection = all(false);
  for (const lane of LANES)
    selection[lane] = LANE_PACKAGES[lane].some((name) => affectedPackages.includes(name));
  for (const { pattern, lanes } of EXTRA)
    if (changedFiles.some((file) => pattern.test(file)))
      for (const lane of lanes) selection[lane] = true;
  return selection;
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { encoding: "utf8" }).trim();
}

function main() {
  const [event = "", base = "", head = "HEAD"] = process.argv.slice(2);
  let selection: Selection;
  if (event !== "pull_request") {
    selection = all(true);
  } else {
    if (!base) throw new Error("A pull request needs its base SHA.");
    const mergeBase = git(["merge-base", base, head]);
    const changed = git(["diff", "--name-only", mergeBase, head]).split("\n").filter(Boolean);
    const turbo = JSON.parse(
      execFileSync("node_modules/.bin/turbo", ["ls", "--affected", "--output=json"], {
        encoding: "utf8",
        env: { ...process.env, TURBO_SCM_BASE: mergeBase, TURBO_SCM_HEAD: head },
      }),
    ) as { packages: { items: { name: string }[] } };
    const affected = turbo.packages.items.map((item) => item.name);
    console.error(
      `changed files: ${changed.length}; affected packages: ${affected.join(", ") || "none"}`,
    );
    selection = selectLanes(event, changed, affected);
  }
  const lines = LANES.map((lane) => `${lane}=${selection[lane]}`);
  console.error(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  else console.log(lines.join("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
