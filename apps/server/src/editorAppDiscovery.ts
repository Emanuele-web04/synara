// FILE: editorAppDiscovery.ts
// Purpose: Shared helpers for resolving editor app bundles without duplicating
//          macOS application search rules across launch and icon extraction.
// Layer: Server runtime utility
// Exports: macOS app search/name helpers used by open.ts and editorAppIcons.ts
// Depends on: EDITORS metadata plus filesystem stat checks.

import { statSync } from "node:fs";
import { join } from "node:path";

import { EDITORS } from "@t3tools/contracts";

export type EditorDefinition = (typeof EDITORS)[number];

export function getEditorMacApplications(editor: EditorDefinition): readonly string[] | undefined {
  return "macApplications" in editor ? editor.macApplications : undefined;
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
