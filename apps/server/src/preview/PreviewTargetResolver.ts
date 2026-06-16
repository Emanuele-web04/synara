import fs from "node:fs/promises";
import path from "node:path";

const PREVIEW_SCRIPT_PRIORITY = ["dev", "start", "serve", "preview", "storybook"] as const;
const KNOWN_FRONTEND_DIRS = [
  "apps",
  "packages",
  "web",
  "app",
  "client",
  "frontend",
  "site",
  "ui",
  "www",
];
const MAX_CANDIDATE_DIRS = 80;

export type PreviewPackageManager = "bun" | "pnpm" | "yarn" | "npm";
export type PreviewResolverKind = "url" | "package-script" | "static";
export type PreviewFramework =
  | "vite"
  | "next"
  | "astro"
  | "sveltekit"
  | "nuxt"
  | "angular"
  | "gatsby"
  | "storybook"
  | "remix"
  | "static"
  | "unknown";

export interface PreviewTargetResolution {
  runCwd: string;
  url: string;
  command: string | null;
  resolverKind: PreviewResolverKind;
  framework: PreviewFramework;
  scriptName: string | null;
  diagnostics: string[];
}

interface PackageJsonShape {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

interface PreviewCandidate {
  cwd: string;
  score: number;
  framework: PreviewFramework;
  packageJson: PackageJsonShape | null;
  scriptName: string | null;
  diagnostics: string[];
}

export function normalizeLocalUrl(url: string): string {
  return url.replace("://0.0.0.0", "://127.0.0.1").replace("://[::]", "://127.0.0.1");
}

export function extractLocalUrl(output: string): string | null {
  const match = output.match(
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::\d+)?[^\s'")<>]*/i,
  );
  return match ? normalizeLocalUrl(match[0]) : null;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function anyFileExists(dir: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if (await fileExists(path.join(dir, name))) {
      return true;
    }
  }
  return false;
}

function packageManagerFromPackageJson(value: string | undefined): PreviewPackageManager | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("bun@")) return "bun";
  if (normalized.startsWith("pnpm@")) return "pnpm";
  if (normalized.startsWith("yarn@")) return "yarn";
  if (normalized.startsWith("npm@")) return "npm";
  return null;
}

async function detectPackageManager(
  cwd: string,
  packageJson: PackageJsonShape | null,
): Promise<PreviewPackageManager> {
  const declaredManager = packageManagerFromPackageJson(packageJson?.packageManager);
  if (declaredManager) return declaredManager;
  for (let current = cwd; ; current = path.dirname(current)) {
    if (await fileExists(path.join(current, "bun.lockb"))) return "bun";
    if (await fileExists(path.join(current, "bun.lock"))) return "bun";
    if (await fileExists(path.join(current, "pnpm-lock.yaml"))) return "pnpm";
    if (await fileExists(path.join(current, "yarn.lock"))) return "yarn";
    if (await fileExists(path.join(current, "package-lock.json"))) return "npm";
    if (current !== cwd) {
      const parentPackageJson = await readJsonFile<PackageJsonShape>(
        path.join(current, "package.json"),
      );
      const parentManager = packageManagerFromPackageJson(parentPackageJson?.packageManager);
      if (parentManager) return parentManager;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
  }
  return "npm";
}

function commandForPackageManager(manager: PreviewPackageManager, scriptName: string): string {
  switch (manager) {
    case "bun":
      return `bun run ${scriptName}`;
    case "pnpm":
      return `pnpm run ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
    case "npm":
      return `npm run ${scriptName}`;
  }
}

function packageNames(packageJson: PackageJsonShape | null): Set<string> {
  return new Set([
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(packageJson?.devDependencies ?? {}),
  ]);
}

function workspacePatterns(packageJson: PackageJsonShape | null): string[] {
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) return workspaces;
  return workspaces?.packages ?? [];
}

function bestScriptName(scripts: Record<string, string>): string | null {
  return PREVIEW_SCRIPT_PRIORITY.find((candidate) => scripts[candidate]) ?? null;
}

function scriptHasPortArg(scriptCommand: string): boolean {
  return /(?:^|\s)(?:--port|-p)(?:\s|=|$)/.test(scriptCommand);
}

function portArgsForFramework(framework: PreviewFramework, port: number): string | null {
  switch (framework) {
    case "vite":
    case "astro":
    case "sveltekit":
    case "nuxt":
    case "angular":
    case "gatsby":
    case "storybook":
    case "remix":
      return `-- --host 127.0.0.1 --port ${port}`;
    case "next":
      return `-- -H 127.0.0.1 -p ${port}`;
    default:
      return null;
  }
}

async function detectFramework(input: {
  cwd: string;
  packageJson: PackageJsonShape | null;
  scriptCommand: string;
}): Promise<PreviewFramework> {
  const packages = packageNames(input.packageJson);
  const script = input.scriptCommand.toLowerCase();
  const has = (name: string) => packages.has(name) || script.includes(name);

  if (
    await anyFileExists(input.cwd, [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mjs",
      "vite.config.cjs",
    ])
  ) {
    return "vite";
  }
  if (await anyFileExists(input.cwd, ["next.config.ts", "next.config.js", "next.config.mjs"])) {
    return "next";
  }
  if (await anyFileExists(input.cwd, ["astro.config.ts", "astro.config.mjs", "astro.config.js"])) {
    return "astro";
  }
  if (await anyFileExists(input.cwd, ["svelte.config.js", "svelte.config.ts"])) {
    return "sveltekit";
  }
  if (await anyFileExists(input.cwd, ["nuxt.config.ts", "nuxt.config.js"])) {
    return "nuxt";
  }
  if (await anyFileExists(input.cwd, ["angular.json"])) {
    return "angular";
  }
  if (await anyFileExists(input.cwd, ["gatsby-config.ts", "gatsby-config.js"])) {
    return "gatsby";
  }
  if (has("@storybook/react") || has("@storybook/vue3") || script.includes("storybook")) {
    return "storybook";
  }
  if (has("@remix-run/dev") || has("@react-router/dev")) {
    return "remix";
  }
  if (has("next")) return "next";
  if (has("astro")) return "astro";
  if (has("@sveltejs/kit")) return "sveltekit";
  if (has("nuxt")) return "nuxt";
  if (has("@angular/core") || has("@angular/cli")) return "angular";
  if (has("gatsby")) return "gatsby";
  if (has("vite")) return "vite";
  return "unknown";
}

async function expandWorkspacePattern(root: string, pattern: string): Promise<string[]> {
  const cleaned = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!cleaned || cleaned.includes("node_modules")) return [];
  if (!cleaned.includes("*")) {
    const dir = path.resolve(root, cleaned);
    return (await directoryExists(dir)) ? [dir] : [];
  }
  if (!cleaned.endsWith("/*")) return [];
  const parent = path.resolve(root, cleaned.slice(0, -2));
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(parent, entry.name));
  } catch {
    return [];
  }
}

async function collectCandidateDirs(root: string): Promise<string[]> {
  const rootPackageJson = await readJsonFile<PackageJsonShape>(path.join(root, "package.json"));
  const dirs = new Set<string>([root]);
  const patterns = new Set([...workspacePatterns(rootPackageJson), "apps/*", "packages/*"]);
  for (const pattern of patterns) {
    for (const dir of await expandWorkspacePattern(root, pattern)) {
      dirs.add(dir);
    }
  }
  for (const name of KNOWN_FRONTEND_DIRS) {
    const direct = path.join(root, name);
    if (await directoryExists(direct)) {
      dirs.add(direct);
    }
  }
  return [...dirs].slice(0, MAX_CANDIDATE_DIRS);
}

async function describeCandidate(cwd: string, root: string): Promise<PreviewCandidate | null> {
  const packageJson = await readJsonFile<PackageJsonShape>(path.join(cwd, "package.json"));
  const scripts = packageJson?.scripts ?? {};
  const scriptName = bestScriptName(scripts);
  const hasIndexHtml = await fileExists(path.join(cwd, "index.html"));
  if (!packageJson && !hasIndexHtml) {
    return null;
  }

  const scriptCommand = scriptName ? (scripts[scriptName] ?? "") : "";
  const framework =
    hasIndexHtml && !packageJson
      ? "static"
      : await detectFramework({ cwd, packageJson, scriptCommand });
  let score = cwd === root ? 8 : 16;
  const diagnostics: string[] = [];

  if (scriptName) score += scriptName === "dev" ? 45 : 30;
  if (framework !== "unknown" && framework !== "static") score += 35;
  if (hasIndexHtml) score += 10;
  if (await directoryExists(path.join(cwd, "src"))) score += 8;
  if (await directoryExists(path.join(cwd, "pages"))) score += 8;
  if (await directoryExists(path.join(cwd, "app"))) score += 8;
  if (packageJson && workspacePatterns(packageJson).length > 0 && cwd === root) {
    score -= 18;
    diagnostics.push("Root package appears to be a workspace container.");
  }
  if (!scriptName && hasIndexHtml) {
    score += 12;
    diagnostics.push("Using static index.html fallback.");
  }
  if (!scriptName && !hasIndexHtml) {
    return null;
  }

  return { cwd, score, framework, packageJson, scriptName, diagnostics };
}

async function commandForCandidate(candidate: PreviewCandidate, port: number): Promise<string> {
  if (!candidate.scriptName) {
    return `python3 -m http.server ${port} --bind 127.0.0.1`;
  }
  const manager = await detectPackageManager(candidate.cwd, candidate.packageJson);
  const command = commandForPackageManager(manager, candidate.scriptName);
  const scriptCommand = candidate.packageJson?.scripts?.[candidate.scriptName] ?? "";
  if (scriptHasPortArg(scriptCommand)) {
    return command;
  }
  const portArgs = portArgsForFramework(candidate.framework, port);
  return portArgs ? `${command} ${portArgs}` : command;
}

export async function resolvePreviewTarget(input: {
  cwd: string;
  port: number;
  command?: string;
  target?: string;
  url?: string;
}): Promise<PreviewTargetResolution> {
  const root = path.resolve(input.cwd.trim());
  const explicitUrl =
    input.url?.trim() || (input.target && isHttpUrl(input.target) ? input.target.trim() : "");
  if (explicitUrl) {
    return {
      runCwd: root,
      url: normalizeLocalUrl(explicitUrl),
      command: null,
      resolverKind: "url",
      framework: "unknown",
      scriptName: null,
      diagnostics: ["Using explicit live edit URL."],
    };
  }
  if (!(await directoryExists(root))) {
    throw new Error(
      `Live Edit project path does not exist: ${root}. Reopen the project from its real folder, or pass an explicit URL with /live-edit --url http://localhost:5173.`,
    );
  }

  const runRoot =
    input.target && input.target.trim().length > 0 ? path.resolve(root, input.target.trim()) : root;
  if (!(await directoryExists(runRoot))) {
    throw new Error(
      `Live Edit target path does not exist: ${runRoot}. Check the /live-edit path argument, or omit it to auto-detect the frontend.`,
    );
  }
  if (input.command && input.command.trim().length > 0) {
    return {
      runCwd: runRoot,
      url: `http://127.0.0.1:${input.port}/`,
      command: input.command.trim(),
      resolverKind: "package-script",
      framework: "unknown",
      scriptName: null,
      diagnostics: ["Using explicit live edit command."],
    };
  }

  const candidateDirs = input.target ? [runRoot] : await collectCandidateDirs(root);
  const candidates = (await Promise.all(candidateDirs.map((dir) => describeCandidate(dir, root))))
    .filter((candidate): candidate is PreviewCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) {
    throw new Error(
      "No frontend preview target found. Expected a package.json dev/start/serve/preview script or an index.html file.",
    );
  }

  const command = await commandForCandidate(best, input.port);
  return {
    runCwd: best.cwd,
    url: `http://127.0.0.1:${input.port}/`,
    command,
    resolverKind: best.scriptName ? "package-script" : "static",
    framework: best.framework,
    scriptName: best.scriptName,
    diagnostics: [
      `Selected ${path.relative(root, best.cwd) || "."} (${best.framework}, score ${best.score}).`,
      ...best.diagnostics,
    ],
  };
}
