// Dependency-free planning: no workspace install is needed before selecting lanes.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const flags = ["code", "unit", "browser", "build", "windows"];
const knownNames = ["contracts", "shared", "web", "cli", "desktop", "scripts", "marketing"];

export function readWorkspaces(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const patterns = manifest.workspaces.packages ?? manifest.workspaces;
  const directories = patterns.flatMap((pattern) => {
    if (!pattern.includes("*")) return [pattern];
    if (!/^[^*]+\/\*$/.test(pattern)) throw new Error(`Unsupported workspace glob: ${pattern}`);
    const parent = pattern.slice(0, -2);
    return readdirSync(resolve(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`);
  });
  return directories.map((directory) => {
    const pkg = JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8"));
    return {
      directory,
      name: pkg.name,
      dependencies: Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.optionalDependencies,
        ...pkg.peerDependencies,
      }),
    };
  });
}

function isProse(file) {
  // Do not treat executable docs/ or assets/ directories inside apps as prose.
  return (
    /^[^/]+\.md$/.test(file) ||
    /^(docs|\.docs|\.plans|\.github)\/.*\.(md|mdx|png|jpg|jpeg|gif|svg|webp|ico)$/.test(file) ||
    /^(apps|packages)\/[^/]+\/(README|AGENTS|CLAUDE)\.md$/.test(file) ||
    /^apps\/marketing\/content\//.test(file)
  );
}

export function planChanges(files, workspaces, full = false) {
  const names = new Set(workspaces.map((workspace) => workspace.name));
  // New/renamed workspaces need an explicit lane ownership review, not a silent skip.
  let broad = full || names.size !== knownNames.length;
  broad ||= knownNames.some((name) => !names.has(`@synara/${name}`));
  const affected = new Set();
  for (const file of files) {
    if (isProse(file)) continue;
    const workspace = workspaces.find(({ directory }) => file.startsWith(`${directory}/`));
    if (
      !workspace ||
      file.endsWith("/package.json") ||
      ["@synara/contracts", "@synara/shared", "@synara/scripts"].includes(workspace.name)
    ) {
      broad = true;
    } else {
      affected.add(workspace.name);
    }
  }
  // Traverse reverse manifest dependencies, including devDependencies: the CLI
  // embeds the web build. Desktop packaging also embeds the CLI, an implicit edge
  // represented by build:desktop rather than apps/desktop/package.json.
  let changed = true;
  while (changed) {
    changed = false;
    for (const workspace of workspaces) {
      const dependencies = [...workspace.dependencies];
      if (workspace.name === "@synara/desktop") dependencies.push("@synara/cli");
      if (!affected.has(workspace.name) && dependencies.some((name) => affected.has(name))) {
        affected.add(workspace.name);
        changed = true;
      }
    }
  }
  const web = broad || affected.has("@synara/web");
  const server = broad || affected.has("@synara/cli");
  const desktop = broad || affected.has("@synara/desktop");
  const code = broad || affected.size > 0;
  const include = [];
  if (web) include.push({ pkg: "web", filters: "--filter=@synara/web", "test-args": "" });
  if (server) {
    for (const shard of ["1/2", "2/2"]) {
      include.push({
        pkg: `server ${shard}`,
        filters: "--filter=@synara/cli",
        "test-args": `--shard=${shard}`,
      });
    }
  }
  return {
    code,
    unit: include.length > 0,
    browser: web,
    build: desktop || server || web,
    windows: desktop || server,
    // A nonempty placeholder avoids an empty matrix even when the job is skipped.
    matrix: { include: include.length ? include : [{ pkg: "not-selected", filters: "", "test-args": "" }] },
  };
}

export function changedFiles(root, base) {
  if (!/^[a-f0-9]{40}$/.test(base ?? "")) throw new Error("Missing or invalid PR base SHA");
  // No API file-count limit, shell interpolation, or rename loss. A rename is
  // deliberately represented as both deletion and addition, so both sides count.
  return execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${base}...HEAD`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).split("\0").filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.cwd();
  const full = process.env.GITHUB_EVENT_NAME !== "pull_request";
  const files = full ? [] : changedFiles(root, process.env.CI_BASE_SHA);
  const plan = planChanges(files, readWorkspaces(root), full);
  const output = flags.map((flag) => `${flag}=${plan[flag]}`);
  output.push(`matrix=${JSON.stringify(plan.matrix)}`);
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, `${output.join("\n")}\n`);
  console.log(JSON.stringify({ changedFiles: files.length, full, plan }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI selection\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`);
  }
}
