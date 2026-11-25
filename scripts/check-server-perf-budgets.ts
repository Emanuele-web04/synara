// FILE: check-server-perf-budgets.ts
// Purpose: Enforce deterministic and runtime performance budgets on the built
//          Synara server bundle so startup, bundle size, and lazy-import gains
//          cannot silently regress in CI.
// Layer: CI verification script

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(repoRoot, "apps/server/dist");
const entryPath = join(distDir, "index.mjs");

const MULTIPLIER = Math.max(1, Number(process.env.SYNARA_PERF_BUDGET_MULTIPLIER ?? "1") || 1);

const BUDGETS = {
  // Minified dist/index.mjs was ~9.00 MB pre-optimization, ~4.60 MB after.
  entryBytes: Math.round(5.5 * 1024 * 1024),
  // Total dist/*.mjs was ~11.44 MB pre-optimization, ~5.35 MB after.
  totalMjsBytes: Math.round(6.5 * 1024 * 1024),
  // Cold `--help` module load (locally ~140-180ms; generous headroom for shared CI runners).
  coldModuleLoadP50Ms: Math.round(1_500 * MULTIPLIER),
  // Existing-DB spawn -> /health startupReady (locally ~330-380ms; generous CI headroom).
  existingDbStartupReadyMs: Math.round(3_000 * MULTIPLIER),
} as const;

// Heavy optional/feature packages kept off the server boot path via lazy loaders.
const FORBIDDEN_BOOT_STATIC_IMPORTS = [
  "undici",
  "jose",
  "mdast-util-from-markdown",
  "yaml",
  "@pierre/diffs",
  "shiki",
] as const;

// Matches static ESM imports in both formatted and minified bundles:
//   import{a as b}from"pkg";
//   import * as x from "pkg";
//   import x from "pkg";
//   import"pkg";
const STATIC_IMPORT_RE =
  /(?:^|[;\n])\s*import(?:\s*(?:[A-Za-z0-9_$,*\s{}]+?)\s*from\s*|\s*)["']([^"'\s$]+)["']\s*(?=[;\n]|$)/g;

function extractStaticImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT_RE)) {
    const spec = match[1];
    if (spec) specifiers.push(spec);
  }
  return specifiers;
}

function collectEagerBootImports(rootFile: string): Set<string> {
  const visited = new Set<string>();
  const externalImports = new Set<string>();
  const queue = [resolve(rootFile)];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const source = readFileSync(current, "utf8");
    for (const spec of extractStaticImports(source)) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const nextFile = resolve(dirname(current), spec);
        if (!visited.has(nextFile)) {
          queue.push(nextFile);
        }
      } else {
        externalImports.add(spec);
      }
    }
  }
  return externalImports;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

async function measureServerBoot(homeDir: string): Promise<{ startupReadyMs: number }> {
  const port = await getFreePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SYNARA_MODE: "desktop",
    SYNARA_PORT: String(port),
    SYNARA_HOST: "127.0.0.1",
    SYNARA_HOME: homeDir,
    SYNARA_NO_BROWSER: "1",
    SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
  };
  delete env.SYNARA_AUTH_TOKEN;
  delete env.VITE_DEV_SERVER_URL;
  delete env.NODE_COMPILE_CACHE;

  const t0 = performance.now();
  const child = spawn(process.execPath, [entryPath], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const deadline = t0 + Math.max(15_000, BUDGETS.existingDbStartupReadyMs * 3);
  try {
    while (performance.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `Server exited early with code ${child.exitCode} during perf budget check:\n${stderr}`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (res.ok) {
          const body = (await res.json()) as { startupReady?: boolean };
          if (body.startupReady) {
            return { startupReadyMs: performance.now() - t0 };
          }
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timed out waiting for server /health startupReady:\n${stderr}`);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          resolveExit();
        }, 3_000);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    }
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];

  // 1. Bundle size budgets
  let entryBytes: number;
  try {
    entryBytes = statSync(entryPath).size;
  } catch {
    throw new Error(
      `Missing built server bundle at ${entryPath}. Run "bun run --cwd apps/server build" first.`,
    );
  }
  const mjsFiles = readdirSync(distDir).filter((name) => name.endsWith(".mjs"));
  const totalMjsBytes = mjsFiles.reduce((sum, name) => sum + statSync(join(distDir, name)).size, 0);

  if (entryBytes > BUDGETS.entryBytes) {
    failures.push(
      `dist/index.mjs size ${formatMb(entryBytes)} exceeds budget ${formatMb(BUDGETS.entryBytes)}`,
    );
  }
  if (totalMjsBytes > BUDGETS.totalMjsBytes) {
    failures.push(
      `total dist/*.mjs size ${formatMb(totalMjsBytes)} exceeds budget ${formatMb(BUDGETS.totalMjsBytes)}`,
    );
  }

  // 2. Boot-path static external import guard
  const eagerImports = collectEagerBootImports(entryPath);
  const nonBuiltinImports = [...eagerImports]
    .filter((spec) => !spec.startsWith("node:"))
    .toSorted();
  if (eagerImports.size === 0) {
    failures.push("Failed to parse any static imports from dist/index.mjs (parser regression).");
  }
  const forbiddenHits = FORBIDDEN_BOOT_STATIC_IMPORTS.filter(
    (pkg) => eagerImports.has(pkg) || [...eagerImports].some((spec) => spec.startsWith(`${pkg}/`)),
  );
  if (forbiddenHits.length > 0) {
    failures.push(
      `Forbidden lazy-loaded packages found in static boot imports of dist/index.mjs: ${forbiddenHits.join(", ")}`,
    );
  }

  // 3. Cold `--help` module-load latency (median of 3)
  const moduleLoadRuns: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    const res = spawnSync(process.execPath, [entryPath, "--help"], {
      cwd: repoRoot,
      env: { ...process.env, NODE_COMPILE_CACHE: "" },
      encoding: "utf8",
      timeout: 15_000,
    });
    const elapsed = performance.now() - t0;
    if (res.status !== 0) {
      failures.push(`Server --help exited with status ${res.status}: ${res.stderr}`);
      break;
    }
    moduleLoadRuns.push(elapsed);
  }
  moduleLoadRuns.sort((a, b) => a - b);
  const coldModuleLoadP50Ms = moduleLoadRuns[Math.floor(moduleLoadRuns.length / 2)] ?? 0;
  if (coldModuleLoadP50Ms > BUDGETS.coldModuleLoadP50Ms) {
    failures.push(
      `Cold --help module-load p50 ${coldModuleLoadP50Ms.toFixed(1)}ms exceeds budget ${BUDGETS.coldModuleLoadP50Ms}ms`,
    );
  }

  // 4. Existing-DB spawn -> /health startupReady latency
  const tempHome = mkdtempSync(join(tmpdir(), "synara-perf-budget-"));
  let existingDbStartupReadyMs = 0;
  try {
    // First boot creates & migrates the DB; second boot measures normal existing-DB cold start.
    await measureServerBoot(tempHome);
    const secondBoot = await measureServerBoot(tempHome);
    existingDbStartupReadyMs = secondBoot.startupReadyMs;
    if (existingDbStartupReadyMs > BUDGETS.existingDbStartupReadyMs) {
      failures.push(
        `Existing-DB startupReady ${existingDbStartupReadyMs.toFixed(1)}ms exceeds budget ${BUDGETS.existingDbStartupReadyMs}ms`,
      );
    }
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }

  console.log(
    [
      "Server performance budget check:",
      `  dist/index.mjs:     ${formatMb(entryBytes)} / ${formatMb(BUDGETS.entryBytes)}`,
      `  total dist/*.mjs:   ${formatMb(totalMjsBytes)} / ${formatMb(BUDGETS.totalMjsBytes)}`,
      `  boot static imports: ${nonBuiltinImports.length} non-builtin (${nonBuiltinImports.join(", ")})`,
      `  cold --help p50:    ${coldModuleLoadP50Ms.toFixed(1)}ms / ${BUDGETS.coldModuleLoadP50Ms}ms`,
      `  existing-DB ready:  ${existingDbStartupReadyMs.toFixed(1)}ms / ${BUDGETS.existingDbStartupReadyMs}ms`,
    ].join("\n"),
  );

  if (failures.length > 0) {
    console.error("\nPerformance budget failures:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
}

await main();
