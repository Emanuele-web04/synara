// FILE: typecheck.ts
// Purpose: Repository typecheck. `bun check` type-checks every project; the
//          Effect language-service diagnostics run separately, because only the
//          patched TypeScript 7 compiler reports them.
// Layer: Root `typecheck` script, CI static lane and release quality gate.
// Usage: node scripts/typecheck.ts [--only=types|effect]

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every tsconfig the per-package `typecheck` scripts checked before this
 * script replaced them. scripts/typecheck.test.ts fails when a workspace
 * tsconfig.json is missing here.
 */
export const TYPECHECK_PROJECTS = [
  "apps/analytics",
  "apps/api",
  "apps/api/cloudflare/tsconfig.json",
  "apps/desktop",
  "apps/desktop/tsconfig.fixtures.json",
  "apps/e2e",
  "apps/marketing",
  "apps/profiles",
  "apps/server",
  "apps/web",
  "packages/contracts",
  "packages/profile-ui",
  "packages/shared",
  "scripts",
  "scripts/tsconfig.computer-measurement.json",
] as const;

const tsconfigPath = (project: string) =>
  join(root, project.endsWith(".json") ? project : join(project, "tsconfig.json"));

/** Projects whose tsconfig enables the Effect language service plugin. */
export function effectProjects(read = (path: string) => readFileSync(path, "utf8")): string[] {
  return TYPECHECK_PROJECTS.filter((project) =>
    read(tsconfigPath(project)).includes('"@effect/language-service"'),
  );
}

type Result = { readonly label: string; readonly code: number; readonly seconds: number };

function run(label: string, command: string, args: readonly string[]): Promise<Result> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    const finish = (code: number) =>
      resolve({ label, code, seconds: (performance.now() - started) / 1000 });
    child.on("error", (error) => {
      console.error(`${label}: ${error.message}`);
      finish(1);
    });
    child.on("exit", (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}

/** One `bun check` per project, in order: each run already uses every core. */
async function checkTypes(): Promise<Result[]> {
  const results: Result[] = [];
  for (const project of TYPECHECK_PROJECTS) {
    results.push(
      await run(`bun check ${project}`, "bun", [
        "check",
        "--no-script",
        "--noEmit",
        "--no-pretty",
        "-p",
        project,
      ]),
    );
  }
  return results;
}

/** The patched TypeScript 7 compiler reports Effect diagnostics alongside type errors. */
async function checkEffect(): Promise<Result[]> {
  const patch = await run("effect-tsgo patch", "node", [
    join(root, "node_modules/@effect/tsgo/dist/effect-tsgo.cjs"),
    "patch",
    "--typescript",
    "--typescript-package",
    "@typescript/native",
  ]);
  if (patch.code !== 0) return [patch];
  const tsc = join(root, "node_modules/@typescript/native/bin/tsc");
  return Promise.all(
    effectProjects().map((project) => {
      // Composite projects write build info; keep it out of the source tree.
      const composite = /"composite":\s*true/.test(readFileSync(tsconfigPath(project), "utf8"));
      const buildInfo = composite
        ? ["--tsBuildInfoFile", join(project, "node_modules/.cache/typescript-native.tsbuildinfo")]
        : [];
      return run(`effect diagnostics ${project}`, "node", [
        tsc,
        "--noEmit",
        "--pretty",
        "false",
        ...buildInfo,
        "-p",
        project,
      ]);
    }),
  );
}

async function main() {
  const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
  if (only !== undefined && only !== "types" && only !== "effect") {
    console.error(`Unknown --only=${only}; expected types or effect.`);
    process.exit(2);
  }
  const groups = await Promise.all([
    only === "effect" ? [] : checkTypes(),
    only === "types" ? [] : checkEffect(),
  ]);
  const results = groups.flat();
  for (const result of results) {
    const status = result.code === 0 ? "ok" : `failed (${result.code})`;
    console.log(`${result.label}: ${status} in ${result.seconds.toFixed(2)} s`);
  }
  if (results.some((result) => result.code !== 0)) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
