// FILE: editorAppDiscovery.ts
// Purpose: Shared helpers for resolving installed editor apps/packages without
//          duplicating platform-specific search rules across launch and icons.
// Layer: Server runtime utility
// Exports: app/package search helpers used by open.ts and editorAppIcons.ts
// Depends on: EDITORS metadata plus filesystem stat checks.

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { EDITORS } from "@t3tools/contracts";

export type EditorDefinition = (typeof EDITORS)[number];

export interface WindowsStorePackageDefinition {
  readonly packageName: string;
  readonly publisherId: string;
}

type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: true;
  },
) => string | Buffer;

const POWERSHELL_APPX_LOOKUP_TIMEOUT_MS = 1_500;

export function getEditorMacApplications(editor: EditorDefinition): readonly string[] | undefined {
  return "macApplications" in editor ? editor.macApplications : undefined;
}

export function getEditorWindowsUriScheme(editor: EditorDefinition): string | undefined {
  return "windowsUriScheme" in editor ? editor.windowsUriScheme : undefined;
}

export function getEditorWindowsStorePackages(
  editor: EditorDefinition,
): readonly WindowsStorePackageDefinition[] | undefined {
  return "windowsStorePackages" in editor ? editor.windowsStorePackages : undefined;
}

export function normalizeMacApplicationBundleName(appName: string): string {
  return appName.endsWith(".app") ? appName : `${appName}.app`;
}

// Checks the standard user/system app locations, including JetBrains Toolbox installs.
export function resolveMacApplicationSearchPaths(
  appName: string,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const bundleName = normalizeMacApplicationBundleName(appName);
  const home = env.HOME?.trim();
  const homeCandidates = home
    ? [
        join(home, "Applications", bundleName),
        join(home, "Applications", "JetBrains Toolbox", bundleName),
      ]
    : [];

  return [
    ...homeCandidates,
    join("/Applications", bundleName),
    join("/Applications", "Utilities", bundleName),
    join("/Applications", "JetBrains Toolbox", bundleName),
    join("/System", "Applications", bundleName),
    join("/System", "Applications", "Utilities", bundleName),
  ];
}

export function resolveMacApplicationBundlePath(
  appNames: readonly string[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform !== "darwin" || !appNames) return null;

  for (const appName of appNames) {
    for (const candidate of resolveMacApplicationSearchPaths(appName, env)) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // Keep probing the remaining standard locations.
      }
    }
  }

  return null;
}

export function resolveAvailableMacApplication(
  appNames: readonly string[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform !== "darwin" || !appNames) return null;

  return (
    appNames.find((appName) =>
      resolveMacApplicationSearchPaths(appName, env).some((candidate) => {
        try {
          return statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      }),
    ) ?? null
  );
}

function trimNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueNonEmpty(values: ReadonlyArray<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => value !== null)));
}

export function resolveWindowsStorePackageSearchRoots(
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const programFiles = trimNonEmpty(env.ProgramFiles);
  const programW6432 = trimNonEmpty(env.ProgramW6432);
  const systemDrive = trimNonEmpty(env.SystemDrive);

  return uniqueNonEmpty([
    programFiles ? join(programFiles, "WindowsApps") : null,
    programW6432 ? join(programW6432, "WindowsApps") : null,
    systemDrive ? join(systemDrive, "Program Files", "WindowsApps") : null,
  ]);
}

function windowsStorePackageDirMatches(
  dirName: string,
  packageDef: WindowsStorePackageDefinition,
): boolean {
  const normalizedName = dirName.toLowerCase();
  const packageName = packageDef.packageName.toLowerCase();
  const publisherId = packageDef.publisherId.toLowerCase();

  return (
    normalizedName === `${packageName}_${publisherId}` ||
    (normalizedName.startsWith(`${packageName}_`) &&
      normalizedName.endsWith(`__${publisherId}`))
  );
}

export function resolveWindowsStorePackageDirectory(
  packages: readonly WindowsStorePackageDefinition[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform !== "win32" || !packages) return null;

  for (const root of resolveWindowsStorePackageSearchRoots(env)) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!packages.some((packageDef) => windowsStorePackageDirMatches(entry.name, packageDef))) {
        continue;
      }

      const packageDir = join(root, entry.name);
      try {
        if (statSync(packageDir).isDirectory()) return packageDir;
      } catch {
        // Keep probing other package roots.
      }
    }
  }

  return null;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function resolveWindowsStorePackageDirectoryFromPowerShell(
  packages: readonly WindowsStorePackageDefinition[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  execFile: ExecFileSyncLike = execFileSync,
): string | null {
  if (platform !== "win32" || !packages) return null;

  const packageNames = Array.from(new Set(packages.map((packageDef) => packageDef.packageName)));
  const packageArray = `@(${packageNames.map(quotePowerShellLiteral).join(",")})`;
  const script = [
    `$packageNames = ${packageArray}`,
    "foreach ($packageName in $packageNames) {",
    "  $package = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue | " +
      "Select-Object -First 1",
    "  if ($null -ne $package -and $package.InstallLocation) {",
    "    Write-Output $package.InstallLocation",
    "    exit 0",
    "  }",
    "}",
    "exit 1",
  ].join("; ");

  try {
    const stdout = execFile("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: POWERSHELL_APPX_LOOKUP_TIMEOUT_MS,
      windowsHide: true,
    });
    return (
      String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
}

export function resolveWindowsStorePackageInstallLocation(
  packages: readonly WindowsStorePackageDefinition[] | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  return (
    resolveWindowsStorePackageDirectory(packages, platform, env) ??
    resolveWindowsStorePackageDirectoryFromPowerShell(packages, platform, env)
  );
}
