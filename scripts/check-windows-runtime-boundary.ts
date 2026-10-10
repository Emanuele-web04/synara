import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

/** Application process code that must reach the window decision through processRuntime. */
const scopedRoots = [
  "apps/server/src/provider",
  "apps/server/src/git",
  "apps/server/src/platform",
  "apps/desktop/src",
] as const;
const scopedFiles = ["apps/server/src/open.ts", "apps/server/src/processRunner.ts"] as const;

/**
 * Boundary code runs the inverse rule: it may decide window visibility itself,
 * but every raw `node:child_process` launch has to declare that decision.
 */
const windowPolicyRoots = ["packages/shared/src"] as const;

/**
 * A Windows process decision that a single file owns, keyed by rule name.
 * There is no blanket immunity — a file is listed only for the decision it
 * implements, and only that rule is skipped for it.
 */
const ownedWindowsDecisions = new Map<string, readonly string[]>([
  // Forwards the launch plan's window policy to the patched Effect spawner.
  ["apps/server/src/platform/effectProcessRuntime.ts", ["windowsHide", "windowsVerbatimArguments"]],
]);

/**
 * Direct workspace dependencies that run Windows process commands outside the
 * boundary. `tree-kill@1.2.2` called `exec('taskkill /pid … /T /F')` with no
 * options, so nothing hid the window; tree signalling goes through
 * `processRuntime` instead. Transitive copies (e.g. via build tooling) are
 * invisible to `package.json` and therefore out of scope here.
 */
const unsafeDirectDependencies = new Set(["tree-kill"]);

/** A raw child_process call, as opposed to the `spawnProcess`/`execProcessFile` wrappers. */
const RAW_PROCESS_LAUNCH =
  /(?<![\w.$])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/;

function walk(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];
  return fs.readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeRoot.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) return walk(relativePath);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [relativePath] : [];
  });
}

function isTestOrFixture(file: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|fixtures|testing)(?:\/|$)/.test(file) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
  );
}

/**
 * Comment-only lines never count as a hit: a banned token written in prose is
 * not a code path, and platform comments legitimately name `taskkill`.
 */
function withoutCommentLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

function isProviderOrGit(file: string): boolean {
  return file.startsWith("apps/server/src/provider/") || file.startsWith("apps/server/src/git/");
}

function ownsNodeSpawnPolicy(file: string): boolean {
  return (
    isProviderOrGit(file) ||
    file.startsWith("apps/server/src/platform/") ||
    file === "apps/server/src/open.ts" ||
    file === "apps/server/src/processRunner.ts" ||
    file === "apps/desktop/src/voiceTranscription.ts" ||
    file === "apps/desktop/src/electronUpdaterSecurity.ts"
  );
}

/**
 * `taskkill` is legal only as an argument to `execProcessFile`, which hides the
 * window. Everything else — a bare `exec`, a `spawn`, a shell string — puts a
 * visible `cmd.exe` under the GUI app, so the sanctioned call is stripped first
 * and the remainder is what gets judged.
 */
function hasUnsafeWindowsCommand(source: string): boolean {
  return /\b(?:where\.exe|taskkill)\b/i.test(source.replace(/execProcessFile\(\s*"taskkill"/g, ""));
}

/** Parenthesis balance of one line, used to read a multi-line launch statement. */
function parenDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === "(") delta += 1;
    else if (char === ")") delta -= 1;
  }
  return delta;
}

/**
 * The launch statement starting at `start`, extended until its parentheses
 * balance. The options object — where `windowsHide` lives — usually spans
 * several lines, so a single-line test would never see it.
 */
function launchStatement(lines: readonly string[], start: number): string {
  let depth = 0;
  const statement: string[] = [];
  const end = Math.min(lines.length, start + 40);
  for (let index = start; index < end; index += 1) {
    const line = lines.at(index);
    if (line === undefined) break;
    statement.push(line);
    depth += parenDelta(line);
    if (depth <= 0) break;
  }
  return statement.join("\n");
}

/** Workspace `package.json` files, excluding anything below `node_modules`. */
function workspaceManifests(dir: string, depth: number): string[] {
  if (depth > 3) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
      return workspaceManifests(path.join(dir, entry.name), depth + 1);
    }
    if (entry.name !== "package.json") return [];
    const relative = path.relative(repoRoot, path.join(dir, entry.name)).replaceAll("\\", "/");
    return [relative];
  });
}

const files = [...new Set([...scopedRoots.flatMap(walk), ...scopedFiles])]
  .filter((file) => !isTestOrFixture(file))
  .toSorted();

const violations: string[] = [];
const report = (file: string, rule: string) => violations.push(`${file}: ${rule}`);

for (const file of files) {
  const source = withoutCommentLines(fs.readFileSync(path.join(repoRoot, file), "utf8"));
  const owns = new Set(ownedWindowsDecisions.get(file) ?? []);

  const forbid = (decision: string, token: RegExp, violation: string) => {
    if (!owns.has(decision) && token.test(source)) report(file, violation);
  };

  forbid(
    "windowsProcess",
    /from\s+["']@synara\/shared\/windowsProcess["']/,
    "import the platform-neutral process runtime instead of windowsProcess",
  );
  forbid(
    "windowsPreparation",
    /\bprepareWindowsSafeProcess\b/,
    "Windows command preparation belongs to platformProcess/processRuntime",
  );
  forbid(
    "windowsVerbatimArguments",
    /\bwindowsVerbatimArguments\b/,
    "windowsVerbatimArguments is owned by the shared process runtime",
  );
  if (hasUnsafeWindowsCommand(source)) {
    report(file, "Windows executable/tree commands belong to the platform boundary");
  }
  forbid(
    "wslTranslation",
    /\b(?:parseWindowsWslUncPath|resolveWindowsWslExe|resolveWindowsComSpec)\b/,
    "WSL and Windows shell translation belong to the shared platform boundary",
  );

  if (ownsNodeSpawnPolicy(file) && !owns.has("windowsHide") && /\bwindowsHide\b/.test(source)) {
    report(file, "windowsHide is selected by processRuntime");
  }

  if (isProviderOrGit(file)) {
    const importsNodeRuntime =
      /import\s+(?:\*\s+as\s+\w+|\{[\s\S]*?\b(?:spawn|spawnSync|exec|execFile)\b[\s\S]*?\})\s+from\s+["']node:child_process["']/.test(
        source,
      );
    if (importsNodeRuntime) {
      report(file, "production process creation must use processRuntime/effectProcessRuntime");
    }
    if (/\bChildProcess\.make\s*\(/.test(source)) {
      report(file, "Effect commands must be created through makeEffectProcessCommand");
    }
    if (
      file !== "apps/server/src/provider/skillsCatalog.ts" &&
      /process\.platform\s*[!=]==?\s*["']win32["']/.test(source)
    ) {
      report(file, "provider/Git process policy must not branch on win32");
    }
  }
}

const windowPolicyFiles = [...windowPolicyRoots.flatMap(walk)]
  .filter((file) => !isTestOrFixture(file))
  .toSorted();

for (const file of windowPolicyFiles) {
  const lines = fs.readFileSync(path.join(repoRoot, file), "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!RAW_PROCESS_LAUNCH.test(line)) return;
    if (/\bwindowsHide\b/.test(launchStatement(lines, index))) return;
    report(file, `line ${index + 1} launches a process without windowsHide`);
  });
}

// Patched dependencies are how third-party process code reaches the runtime.
// Only lines that survive into the installed package count; `-` lines are gone.
const patchDir = path.join(repoRoot, "patches");
const patchNames = fs.existsSync(patchDir)
  ? fs
      .readdirSync(patchDir)
      .filter((entry) => entry.endsWith(".patch"))
      .toSorted()
  : [];
for (const patchName of patchNames) {
  const lines = fs.readFileSync(path.join(patchDir, patchName), "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.startsWith("-")) return;
    const content = line.slice(1).trimStart();
    if (content.startsWith("//") || content.startsWith("*") || content.startsWith("/*")) return;
    if (!/\btaskkill\b/i.test(content)) return;
    if (/\bwindowsHide\b/.test(content)) return;
    report(`patches/${patchName}`, `line ${index + 1} launches taskkill without windowsHide`);
  });
}

const manifests = workspaceManifests(repoRoot, 0);
for (const manifest of manifests) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, manifest), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const sections = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const;
  for (const section of sections) {
    for (const dependency of Object.keys(pkg[section] ?? {})) {
      if (unsafeDirectDependencies.has(dependency)) {
        report(manifest, `${dependency} runs Windows process commands outside processRuntime`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Windows runtime boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    `Windows runtime boundary verified across ${files.length} application source files, ` +
      `${windowPolicyFiles.length} boundary files, ${patchNames.length} dependency patches, ` +
      `and ${manifests.length} workspace manifests.`,
  );
}
