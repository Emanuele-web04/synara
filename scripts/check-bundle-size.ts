#!/usr/bin/env node
// FILE: check-bundle-size.ts
// Purpose: Enforces portable build and packaged desktop release size budgets in CI.
// Layer: CI and release verification script

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type BundleBudgetMode = "portable" | "packaged";
export type BundleBudgetPlatform = "mac" | "win" | "linux";

export interface PortableBundleBudget {
  readonly desktopMainMaxBytes: number;
  readonly serverDistMaxBytes: number;
  readonly webClientMaxBytes: number;
  readonly webClientFontsMaxBytes: number;
  readonly webClientPrecompressedMaxBytes: number;
}

export interface PackagedPlatformBudget {
  readonly installerMaxBytes: number;
  readonly updateZipMaxBytes?: number;
  readonly appAsarMaxBytes?: number;
  readonly installedAppMaxBytes?: number;
}

export interface BundleSizeBudgetConfig {
  readonly portable: PortableBundleBudget;
  readonly packaged: Record<string, PackagedPlatformBudget>;
}

export interface BundleBudgetCheck {
  readonly name: string;
  readonly actualBytes: number;
  readonly maxBytes: number;
  readonly passed: boolean;
}

export interface BundleBudgetReport {
  readonly mode: BundleBudgetMode;
  readonly passed: boolean;
  readonly checks: ReadonlyArray<BundleBudgetCheck>;
  readonly errors: ReadonlyArray<string>;
}

export interface ParsedBundleSizeArgs {
  readonly mode: BundleBudgetMode;
  readonly repoRoot: string;
  readonly budgetPath: string;
  readonly platform?: BundleBudgetPlatform;
  readonly arch?: string;
  readonly assetsDir?: string;
  readonly appDir?: string;
}

const FONT_EXTENSIONS = new Set([".woff", ".woff2", ".ttf", ".otf"]);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_BUDGET_PATH = resolve(SCRIPT_DIR, "bundle-size-budget.json");

export function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function sumDirectoryBytes(
  rootDir: string,
  filter: (relativePosixPath: string) => boolean = () => true,
): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const rel = relative(rootDir, fullPath).replaceAll("\\", "/");
        if (filter(rel)) {
          total += statSync(fullPath).size;
        }
      }
    }
  };
  walk(rootDir);
  return total;
}

function makeCheck(name: string, actualBytes: number, maxBytes: number): BundleBudgetCheck {
  return {
    name,
    actualBytes,
    maxBytes,
    passed: actualBytes <= maxBytes,
  };
}

export function readBundleSizeBudget(budgetPath: string): BundleSizeBudgetConfig {
  return JSON.parse(readFileSync(budgetPath, "utf8")) as BundleSizeBudgetConfig;
}

export function evaluatePortableBundleSize(
  repoRoot: string,
  budget: PortableBundleBudget,
): BundleBudgetReport {
  const errors: string[] = [];
  const checks: BundleBudgetCheck[] = [];

  const desktopDir = join(repoRoot, "apps/desktop/dist-electron");
  const serverDir = join(repoRoot, "apps/server/dist");
  const clientDir = join(repoRoot, "apps/server/dist/client");

  if (!existsSync(desktopDir)) {
    errors.push(`Missing desktop build directory: ${desktopDir}`);
  } else {
    checks.push(
      makeCheck("desktop dist-electron", sumDirectoryBytes(desktopDir), budget.desktopMainMaxBytes),
    );
  }

  if (!existsSync(serverDir)) {
    errors.push(`Missing server build directory: ${serverDir}`);
  } else {
    checks.push(
      makeCheck(
        "server dist (JS/runtime)",
        sumDirectoryBytes(
          serverDir,
          (rel) => !rel.startsWith("client/") && !rel.startsWith("device-helper/"),
        ),
        budget.serverDistMaxBytes,
      ),
    );
  }

  if (!existsSync(clientDir)) {
    errors.push(`Missing web client build directory: ${clientDir}`);
  } else {
    checks.push(
      makeCheck(
        "web client (uncompressed)",
        sumDirectoryBytes(clientDir, (rel) => !rel.endsWith(".gz") && !rel.endsWith(".br")),
        budget.webClientMaxBytes,
      ),
    );
    checks.push(
      makeCheck(
        "web client fonts",
        sumDirectoryBytes(clientDir, (rel) => FONT_EXTENSIONS.has(extname(rel).toLowerCase())),
        budget.webClientFontsMaxBytes,
      ),
    );
    checks.push(
      makeCheck(
        "web client precompressed (.gz/.br)",
        sumDirectoryBytes(clientDir, (rel) => rel.endsWith(".gz") || rel.endsWith(".br")),
        budget.webClientPrecompressedMaxBytes,
      ),
    );
  }

  return {
    mode: "portable",
    passed: errors.length === 0 && checks.every((check) => check.passed),
    checks,
    errors,
  };
}

function findSingleArtifactByExtension(
  assetsDir: string,
  extension: string,
): { readonly path?: string; readonly error?: string } {
  const matches = readdirSync(assetsDir)
    .filter((name) => name.toLowerCase().endsWith(extension.toLowerCase()))
    .sort();
  if (matches.length === 0) {
    return { error: `No ${extension} artifact found in ${assetsDir}.` };
  }
  if (matches.length > 1) {
    return {
      error: `Expected a single ${extension} artifact in ${assetsDir}, found ${matches.join(", ")}.`,
    };
  }
  return { path: join(assetsDir, matches[0]!) };
}

function resolveAppAsarPath(appDir: string, platform: BundleBudgetPlatform): string {
  return platform === "mac"
    ? join(appDir, "Contents/Resources/app.asar")
    : join(appDir, "resources/app.asar");
}

export function evaluatePackagedBundleSize(options: {
  readonly platform: BundleBudgetPlatform;
  readonly arch: string;
  readonly assetsDir: string;
  readonly appDir?: string;
  readonly budgets: Record<string, PackagedPlatformBudget>;
}): BundleBudgetReport {
  const targetKey = `${options.platform}-${options.arch}`;
  const budget = options.budgets[targetKey];
  if (!budget) {
    return {
      mode: "packaged",
      passed: false,
      checks: [],
      errors: [`No packaged size budget defined for ${targetKey}.`],
    };
  }
  if (!existsSync(options.assetsDir)) {
    return {
      mode: "packaged",
      passed: false,
      checks: [],
      errors: [`Assets directory does not exist: ${options.assetsDir}`],
    };
  }

  const errors: string[] = [];
  const checks: BundleBudgetCheck[] = [];

  const installerExt =
    options.platform === "mac" ? ".dmg" : options.platform === "win" ? ".exe" : ".AppImage";
  const installer = findSingleArtifactByExtension(options.assetsDir, installerExt);
  if (installer.error || !installer.path) {
    errors.push(installer.error ?? `Missing ${installerExt} installer.`);
  } else {
    checks.push(
      makeCheck(
        `${targetKey} installer (${installerExt})`,
        statSync(installer.path).size,
        budget.installerMaxBytes,
      ),
    );
  }

  if (options.platform === "mac" && budget.updateZipMaxBytes !== undefined) {
    const updateZip = findSingleArtifactByExtension(options.assetsDir, ".zip");
    if (updateZip.error || !updateZip.path) {
      errors.push(updateZip.error ?? "Missing macOS update .zip artifact.");
    } else {
      checks.push(
        makeCheck(
          `${targetKey} update zip (.zip)`,
          statSync(updateZip.path).size,
          budget.updateZipMaxBytes,
        ),
      );
    }
  }

  if (options.appDir) {
    if (!existsSync(options.appDir)) {
      errors.push(`App directory does not exist: ${options.appDir}`);
    } else {
      if (budget.appAsarMaxBytes !== undefined) {
        const asarPath = resolveAppAsarPath(options.appDir, options.platform);
        if (!existsSync(asarPath)) {
          errors.push(`Missing packaged app.asar at ${asarPath}`);
        } else {
          checks.push(
            makeCheck(`${targetKey} app.asar`, statSync(asarPath).size, budget.appAsarMaxBytes),
          );
        }
      }
      if (budget.installedAppMaxBytes !== undefined) {
        checks.push(
          makeCheck(
            `${targetKey} installed app`,
            sumDirectoryBytes(options.appDir),
            budget.installedAppMaxBytes,
          ),
        );
      }
    }
  }

  return {
    mode: "packaged",
    passed: errors.length === 0 && checks.every((check) => check.passed),
    checks,
    errors,
  };
}

export function parseBundleSizeArgs(argv: ReadonlyArray<string>): ParsedBundleSizeArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}.`);
    }
    values.set(key, value);
  }
  const allowed = new Set([
    "--mode",
    "--repo-root",
    "--budget-file",
    "--platform",
    "--arch",
    "--assets-dir",
    "--app-dir",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown argument: ${key}`);
    }
  }

  const modeRaw = values.get("--mode") ?? "portable";
  if (modeRaw !== "portable" && modeRaw !== "packaged") {
    throw new Error(`Unsupported --mode: ${modeRaw}. Expected portable or packaged.`);
  }
  const platformRaw = values.get("--platform");
  if (
    platformRaw !== undefined &&
    platformRaw !== "mac" &&
    platformRaw !== "win" &&
    platformRaw !== "linux"
  ) {
    throw new Error(`Unsupported --platform: ${platformRaw}. Expected mac, win, or linux.`);
  }

  const parsed: ParsedBundleSizeArgs = {
    mode: modeRaw,
    repoRoot: resolve(values.get("--repo-root") ?? DEFAULT_REPO_ROOT),
    budgetPath: resolve(values.get("--budget-file") ?? DEFAULT_BUDGET_PATH),
    ...(platformRaw ? { platform: platformRaw } : {}),
    ...(values.has("--arch") ? { arch: values.get("--arch")! } : {}),
    ...(values.has("--assets-dir") ? { assetsDir: resolve(values.get("--assets-dir")!) } : {}),
    ...(values.has("--app-dir") ? { appDir: resolve(values.get("--app-dir")!) } : {}),
  };

  if (parsed.mode === "packaged") {
    if (!parsed.platform || !parsed.arch || !parsed.assetsDir) {
      throw new Error(
        "Packaged mode requires --platform <mac|win|linux> --arch <arch> --assets-dir <dir>.",
      );
    }
  }
  return parsed;
}

export function formatBundleBudgetReport(report: BundleBudgetReport): string {
  const lines = [`Bundle size budget check (${report.mode}):`];
  for (const check of report.checks) {
    const delta = check.maxBytes - check.actualBytes;
    const status = check.passed ? "PASS" : "FAIL";
    const headroom =
      delta >= 0 ? `${formatMiB(delta)} headroom` : `${formatMiB(-delta)} over budget`;
    lines.push(
      `  [${status}] ${check.name}: ${formatMiB(check.actualBytes)} / ${formatMiB(check.maxBytes)} (${headroom})`,
    );
  }
  for (const error of report.errors) {
    lines.push(`  [ERROR] ${error}`);
  }
  return lines.join("\n");
}

function main(): void {
  const args = parseBundleSizeArgs(process.argv.slice(2));
  const config = readBundleSizeBudget(args.budgetPath);
  const report =
    args.mode === "portable"
      ? evaluatePortableBundleSize(args.repoRoot, config.portable)
      : evaluatePackagedBundleSize({
          platform: args.platform!,
          arch: args.arch!,
          assetsDir: args.assetsDir!,
          ...(args.appDir ? { appDir: args.appDir } : {}),
          budgets: config.packaged,
        });

  console.log(formatBundleBudgetReport(report));
  if (!report.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
