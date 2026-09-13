// Dependency-aware CI admission. No workspace install is needed to run this file.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WEB = "@synara/web";
const CLI = "@synara/cli";
const DESKTOP = "@synara/desktop";
const KNOWN = new Set([WEB, CLI, DESKTOP, "@synara/marketing"]);
const FOUNDATIONS = new Set(["@synara/shared", "@synara/contracts"]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

export function readWorkspaces(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const patterns = manifest.workspaces?.packages ?? manifest.workspaces;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error("Missing workspace definitions; refusing to infer a docs-only change.");
  }
  const directories = patterns.flatMap((pattern) => {
    if (/^[\w.-]+\/\*$/.test(pattern)) {
      const parent = pattern.slice(0, -2);
      return readdirSync(resolve(root, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`)
        .filter((directory) => existsSync(resolve(root, directory, "package.json")));
    }
    if (/^[\w.-]+(?:\/[\w.-]+)*$/.test(pattern)) return [pattern];
    throw new Error(`Unsupported workspace pattern: ${pattern}`);
  });
  const workspaces = [...new Set(directories)].map((directory) => {
    const pkg = JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8"));
    // Package names become Turbo arguments. Never allow arbitrary shell syntax.
    if (!/^@[a-z0-9-]+\/[a-z0-9._-]+$/.test(pkg.name)) {
      throw new Error(`Unsupported workspace name in ${directory}`);
    }
    return {
      directory,
      name: pkg.name,
      test: typeof pkg.scripts?.test === "string",
      dependencies: DEPENDENCY_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {})),
    };
  });
  if (new Set(workspaces.map((pkg) => pkg.name)).size !== workspaces.length) {
    throw new Error("Duplicate workspace names.");
  }
  for (const required of [WEB, CLI, DESKTOP, ...FOUNDATIONS, "@synara/scripts"]) {
    if (!workspaces.some((pkg) => pkg.name === required)) {
      throw new Error(`Missing required workspace: ${required}`);
    }
  }
  return workspaces;
}

export function isProse(file) {
  // Never treat arbitrary Markdown/MDX inside runtime source or fixtures as docs.
  if (/^[^/]+\.md$/.test(file)) return true;
  if (/^(?:docs|plans|audit|advisor-plans|\.plans|\.docs)\/.*\.(?:md|mdx|png|jpe?g|gif|svg|webp|ico)$/.test(file)) {
    return true;
  }
  if (/^\.github\/.*\.(?:md|png|jpe?g|gif|svg|webp|ico)$/.test(file)) return true;
  return /^(?:apps\/[^/]+|packages\/[^/]+|scripts)\/(?:README|AGENTS|CLAUDE)\.md$/.test(file);
}

export function planChanges(files, workspaces, forceFull = false) {
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string" || !file)) {
    throw new Error("Invalid changed-file list.");
  }
  let full = forceFull;
  const affected = new Set();
  for (const file of files) {
    if (isProse(file)) continue;
    const owner = workspaces.find((pkg) => file.startsWith(`${pkg.directory}/`));
    // Manifests, CI, lockfiles, patches, root configuration, scripts, unknown
    // directories and foundational packages are deliberately broad changes.
    if (
      !owner ||
      !KNOWN.has(owner.name) ||
      file.endsWith("/package.json") ||
      owner.directory === "scripts" ||
      FOUNDATIONS.has(owner.name)
    ) {
      full = true;
    } else {
      affected.add(owner.name);
    }
  }
  if (full) for (const pkg of workspaces) affected.add(pkg.name);
  // Include reverse transitive dependencies, including dev/build/test edges.
  // In particular web -> CLI is declared in apps/server/package.json.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const pkg of workspaces) {
      if (!affected.has(pkg.name) && pkg.dependencies.some((name) => affected.has(name))) {
        affected.add(pkg.name);
        expanded = true;
      }
    }
  }
  const product = full || [...affected].some((name) => name !== "@synara/marketing");
  const core = workspaces.filter((pkg) => pkg.test && pkg.name !== WEB && pkg.name !== CLI);
  if (core.length === 0) throw new Error("Missing core unit suites.");
  const include = [
    {
      pkg: "core",
      filters: core.map((pkg) => `--filter=${pkg.name}`).join(" "),
      args: "",
      server: false,
    },
  ];
  if (affected.has(WEB)) {
    include.push({ pkg: "web", filters: `--filter=${WEB}`, args: "", server: false });
  }
  if (affected.has(CLI)) {
    for (const shard of [1, 2]) {
      include.push({
        pkg: `server ${shard}/2`,
        filters: `--filter=${CLI}`,
        args: `--shard=${shard}/2`,
        server: true,
      });
    }
  }
  return {
    typecheck: full || affected.size > 0,
    product,
    unit: product,
    // Desktop preload/bridge changes are an integration edge beyond manifests.
    browser: full || affected.has(WEB) || affected.has(DESKTOP),
    build: product,
    windows: full || affected.has(CLI) || affected.has(DESKTOP),
    unit_matrix: { include },
    affected: [...affected].sort(),
    full,
  };
}

export function changedFiles(root, base, head = "HEAD") {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Expected an immutable base commit SHA.");
  // PR checkout is the tested merge commit, not an untested head. Fail on absent
  // history, and represent renames as delete+add so neither dependency is lost.
  execFileSync("git", ["merge-base", "--is-ancestor", base, head], { cwd: root });
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, head, "--"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.cwd();
  const full = process.env.GITHUB_EVENT_NAME !== "pull_request";
  const files = full ? [] : changedFiles(root, process.env.CI_BASE_SHA ?? "");
  const plan = planChanges(files, readWorkspaces(root), full);
  console.log(JSON.stringify(plan, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(plan)) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${JSON.stringify(value)}\n`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI admission plan\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`);
  }
}
