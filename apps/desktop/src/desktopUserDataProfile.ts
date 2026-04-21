// FILE: desktopUserDataProfile.ts
// Purpose: Resolves and seeds Electron userData profile paths during the DP Code rename.
// Exports: helpers used by desktop startup and focused migration tests.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const DEV_USER_DATA_DIR_NAME = "dpcode-dev";
const PROD_USER_DATA_DIR_NAME = "dpcode";
const DEV_LEGACY_USER_DATA_DIR_NAMES = ["t3code-dev", "DP Code (Dev)"] as const;
const PROD_LEGACY_USER_DATA_DIR_NAMES = ["t3code", "DP Code (Alpha)"] as const;
const PROFILE_SEED_ENTRY_NAMES = [
  "Local Storage",
  "IndexedDB",
  "Session Storage",
  "Preferences",
] as const;

export interface DesktopUserDataProfileSeedResult {
  readonly status: "seeded" | "target-exists" | "legacy-missing" | "seed-failed";
  readonly sourcePath: string | null;
  readonly targetPath: string;
  readonly error?: unknown;
}

export function resolveDesktopAppDataBase(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): string {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const homeDir = input?.homeDir ?? OS.homedir();

  if (platform === "win32") {
    return env.APPDATA || Path.join(homeDir, "AppData", "Roaming");
  }
  if (platform === "darwin") {
    return Path.join(homeDir, "Library", "Application Support");
  }
  return env.XDG_CONFIG_HOME || Path.join(homeDir, ".config");
}

export function resolveDesktopUserDataPath(input: {
  readonly appDataBase: string;
  readonly isDevelopment: boolean;
}): string {
  return Path.join(
    input.appDataBase,
    input.isDevelopment ? DEV_USER_DATA_DIR_NAME : PROD_USER_DATA_DIR_NAME,
  );
}

export function resolveLegacyDesktopUserDataPaths(input: {
  readonly appDataBase: string;
  readonly isDevelopment: boolean;
}): string[] {
  const legacyNames = input.isDevelopment
    ? DEV_LEGACY_USER_DATA_DIR_NAMES
    : PROD_LEGACY_USER_DATA_DIR_NAMES;
  return legacyNames.map((name) => Path.join(input.appDataBase, name));
}

export function seedDesktopUserDataProfileFromLegacy(input: {
  readonly targetPath: string;
  readonly legacyPaths: readonly string[];
}): DesktopUserDataProfileSeedResult {
  if (FS.existsSync(input.targetPath)) {
    return {
      status: "target-exists",
      sourcePath: null,
      targetPath: input.targetPath,
    };
  }

  const sourcePath =
    input.legacyPaths.find((candidate) => FS.existsSync(candidate) && hasSeedableProfileData(candidate)) ??
    null;
  if (!sourcePath) {
    return {
      status: "legacy-missing",
      sourcePath: null,
      targetPath: input.targetPath,
    };
  }

  try {
    FS.mkdirSync(input.targetPath, { recursive: true });
    for (const entryName of PROFILE_SEED_ENTRY_NAMES) {
      const sourceEntryPath = Path.join(sourcePath, entryName);
      if (!FS.existsSync(sourceEntryPath)) {
        continue;
      }
      FS.cpSync(sourceEntryPath, Path.join(input.targetPath, entryName), {
        recursive: true,
        errorOnExist: false,
        force: false,
      });
    }
    FS.writeFileSync(
      Path.join(input.targetPath, "dpcode-profile-seed.json"),
      `${JSON.stringify(
        {
          sourcePath,
          seededAt: new Date().toISOString(),
          entries: PROFILE_SEED_ENTRY_NAMES,
        },
        null,
        2,
      )}\n`,
    );
    return {
      status: "seeded",
      sourcePath,
      targetPath: input.targetPath,
    };
  } catch (error) {
    return {
      status: "seed-failed",
      sourcePath,
      targetPath: input.targetPath,
      error,
    };
  }
}

function hasSeedableProfileData(profilePath: string): boolean {
  return PROFILE_SEED_ENTRY_NAMES.some((entryName) => FS.existsSync(Path.join(profilePath, entryName)));
}
