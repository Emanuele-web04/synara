// Dependency-free: planning must work before installing the workspace.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const workspacePaths = {
  "@synara/contracts": "packages/contracts",
  "@synara/shared": "packages/shared",
  "@synara/web": "apps/web",
  "@synara/cli": "apps/server",
  "@synara/desktop": "apps/desktop",
  "@synara/marketing": "apps/marketing",
  "@synara/scripts": "scripts",
};

const unitRows = [
  {
    pkg: "core",
    filters: "--filter=\"*\" --filter=!@synara/web --filter=!@synara/cli",
    "test-args": "",
  },
  { pkg: "web", filters: "--filter=@synara/web", "test-args": "" },
  { pkg: "server 1/2", filters: "--filter=@synara/cli", "test-args": "--shard=1/2" },
  { pkg: "server 2/2", filters: "--filter=@synara/cli", "test-args": "--shard=2/2" },
];

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function readGraph(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const patterns = manifest.workspaces?.packages ?? manifest.workspaces;
  if (JSON.stringify(patterns?.toSorted()) !== JSON.stringify(["apps/*", "packages/*", "scripts"])) {
    throw new Error("Workspace layout changed; review CI ownership before narrowing validation.");
  }
  const tracked = git(root, ["ls-files", "-z"]).split("\0");
  const manifests = tracked.filter((path) => /^(?:apps\/[^/]+|packages\/[^/]+|scripts)\/package\.json$/.test(path));
  const expected = Object.values(workspacePaths).map((path) => `${path}/package.json`).toSorted();
  if (JSON.stringify(manifests.toSorted()) !== JSON.stringify(expected)) {
    throw new Error("Workspace inventory changed; full validation is required.");
  }
  const graph = {};
  for (const [name, path] of Object.entries(workspacePaths)) {
    const pkg = JSON.parse(readFileSync(resolve(root, path, "package.json"), "utf8"));
    if (pkg.name !== name) throw new Error(`Unexpected workspace name at ${path}.`);
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    };
    for (const [dependency, version] of Object.entries(dependencies)) {
      if (String(version).startsWith("workspace:") && !Object.hasOwn(workspacePaths, dependency)) {
        throw new Error(`Unknown workspace dependency: ${dependency}.`);
      }
    }
    graph[name] = Object.keys(dependencies).filter((dependency) => Object.hasOwn(workspacePaths, dependency));
  }
  // Packaging includes the CLI (and its web renderer) without declaring it in
  // desktop/package.json. Do not lose this dependency when deciding build lanes.
  graph["@synara/desktop"].push("@synara/cli");
  return graph;
}

export function affectedPackages(changed, graph) {
  const affected = new Set(changed);
  let added;
  do {
    added = false;
    for (const [name, dependencies] of Object.entries(graph)) {
      if (!affected.has(name) && dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(name);
        added = true;
      }
    }
  } while (added);
  return affected;
}

function result(flags, rows, reason, affected = []) {
  return { ...flags, unit: rows.length > 0, matrix: { include: rows }, reason, affected: [...affected].toSorted() };
}

export function fullPlan(reason) {
  return result({ typecheck: true, browser: true, build: true, windows: true, migrations: true }, unitRows, reason);
}

function isDocumentation(path) {
  // Never exempt arbitrary Markdown/MDX or assets inside a runtime workspace:
  // prompts, fixtures, generated modules and UI images can be executable inputs.
  return (
    /^[^/]+\.md$/.test(path) ||
    /^docs\/.*\.(?:md|mdx|png|jpg|jpeg|gif|svg|webp|ico)$/.test(path) ||
    /^\.github\/(?:assets|pr-assets)\/.*\.(?:png|jpg|jpeg|gif|svg|webp|ico)$/.test(path)
  );
}

export function planChanges(paths, graph) {
  if (!paths?.length) return fullPlan("No complete change set; run all lanes.");
  const changed = new Set();
  let code = false;
  let migrations = false;
  for (const path of paths) {
    if (typeof path !== "string" || !path || path.includes("\0") || path.split("/").includes("..")) {
      return fullPlan("Invalid changed path; run all lanes.");
    }
    if (isDocumentation(path)) continue;
    const owner = Object.entries(workspacePaths).find(([, directory]) => path.startsWith(`${directory}/`))?.[0];
    if (
      !owner ||
      path.endsWith("/package.json") ||
      owner === "@synara/contracts" ||
      owner === "@synara/shared" ||
      owner === "@synara/scripts"
    ) {
      return fullPlan("Foundational, infrastructure, manifest or unclassified change.");
    }
    changed.add(owner);
    code ||= !/^apps\/marketing\/content\/.*\.(?:md|mdx|json)$/.test(path);
    migrations ||= path.startsWith("apps/server/src/persistence/");
  }
  const affected = affectedPackages(changed, graph);
  const runtime = [...affected].some((name) => name !== "@synara/marketing");
  // Keep core together: script tests inspect application/release source outside
  // declared package imports. Whole-workspace typechecking also stays uncached.
  const rows = unitRows.filter((row) =>
    row.pkg === "core" ? runtime : affected.has(row.pkg === "web" ? "@synara/web" : "@synara/cli"),
  );
  return result(
    {
      typecheck: code || runtime,
      browser: affected.has("@synara/web"),
      build: affected.has("@synara/desktop") || affected.has("@synara/cli"),
      windows: affected.has("@synara/desktop") || affected.has("@synara/cli"),
      migrations,
    },
    rows,
    "Workspace reverse-dependency closure (including desktop packaging).",
    affected,
  );
}

export function planForEvent(root, eventName, ref) {
  // Main is always broad. Non-PR and non-merge checkouts are not safe diffs.
  if (eventName !== "pull_request" || !/^refs\/pull\/\d+\/merge$/.test(ref ?? "")) {
    return fullPlan("Main or unrecognized event/ref; run all lanes.");
  }
  try {
    const parents = git(root, ["show", "--no-patch", "--format=%P", "HEAD"]).trim().split(" ");
    if (parents.length !== 2) return fullPlan("PR merge parents unavailable; run all lanes.");
    // Diff the tested merge tree against its base, not just the last PR commit.
    // NUL delimiting and --no-renames preserve both sides of moves/deletions;
    // unlike the PR-files API there is no 300/3,000-file truncation limit.
    const paths = git(root, ["diff", "--no-renames", "--name-only", "-z", "HEAD^1", "HEAD"])
      .split("\0")
      .filter(Boolean);
    return planChanges(paths, readGraph(root));
  } catch (error) {
    console.warn(`CI planning uncertainty: ${error.message}`);
    return fullPlan("Diff or dependency graph unavailable; run all lanes.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = planForEvent(process.cwd(), process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF);
  console.log(JSON.stringify(plan, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    for (const key of ["typecheck", "unit", "browser", "build", "windows", "migrations", "matrix"]) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${JSON.stringify(plan[key])}\n`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI plan\n\n${plan.reason}\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`);
  }
}
