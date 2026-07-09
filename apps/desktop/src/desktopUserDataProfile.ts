// FILE: desktopUserDataProfile.ts
// Purpose: Resolves and seeds Electron userData profile paths during app renames.
// Exports: helpers used by desktop startup and focused migration tests.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const DEV_USER_DATA_DIR_NAME = "synara-dev";
const PROD_USER_DATA_DIR_NAME = "synara";
const DEV_LEGACY_USER_DATA_DIR_NAMES = ["dpcode-dev", "t3code-dev", "DP Code (Dev)"] as const;
const PROD_LEGACY_USER_DATA_DIR_NAMES = ["dpcode", "t3code", "DP Code (Alpha)"] as const;
const PROFILE_SEED_ENTRY_NAMES = [
  "Local Storage",
  "IndexedDB",
  "Session Storage",
  "Preferences",
  "Cookies",
  "Cookies-journal",
  "Network Persistent State",
] as const;
const CANONICAL_BROWSER_PARTITION_NAME = "synara-browser";
const LEGACY_BROWSER_PARTITION_NAMES = ["dpcode-browser", "t3code-browser"] as const;
const BROWSER_PARTITION_SEED_ENTRY_NAMES = [
  "Cookies",
  "Cookies-journal",
  "Local Storage",
  "IndexedDB",
  "Session Storage",
  "WebStorage",
  "Service Worker",
  "Preferences",
  "Network Persistent State",
  "TransportSecurity",
  "Trust Tokens",
  "Trust Tokens-journal",
  "SharedStorage",
  "SharedStorage-wal",
  "shared_proto_db",
] as const;

export interface DesktopUserDataProfileSeedResult {
  readonly status:
    | "seeded"
    | "repaired-browser-partition"
    | "target-exists"
    | "legacy-missing"
    | "seed-failed";
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
    const sourcePath = input.legacyPaths.find(
      (candidate) => resolveLegacyBrowserPartitionPath(candidate) !== null,
    );
    try {
      const copiedEntries = sourcePath
        ? seedCanonicalBrowserPartition(sourcePath, input.targetPath)
        : [];
      return {
        status: copiedEntries.length > 0 ? "repaired-browser-partition" : "target-exists",
        sourcePath: copiedEntries.length > 0 ? (sourcePath ?? null) : null,
        targetPath: input.targetPath,
      };
    } catch (error) {
      return {
        status: "seed-failed",
        sourcePath: sourcePath ?? null,
        targetPath: input.targetPath,
        error,
      };
    }
  }

  const sourcePath =
    input.legacyPaths.find(
      (candidate) => FS.existsSync(candidate) && hasSeedableProfileData(candidate),
    ) ?? null;
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
    const copiedBrowserPartitionEntries = seedCanonicalBrowserPartition(
      sourcePath,
      input.targetPath,
    );
    FS.writeFileSync(
      Path.join(input.targetPath, "synara-profile-seed.json"),
      `${JSON.stringify(
        {
          sourcePath,
          seededAt: new Date().toISOString(),
          entries: [
            ...PROFILE_SEED_ENTRY_NAMES,
            ...(copiedBrowserPartitionEntries.length > 0
              ? [`Partitions/${CANONICAL_BROWSER_PARTITION_NAME}`]
              : []),
          ],
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
  return (
    PROFILE_SEED_ENTRY_NAMES.some((entryName) =>
      FS.existsSync(Path.join(profilePath, entryName)),
    ) || resolveLegacyBrowserPartitionPath(profilePath) !== null
  );
}

function resolveLegacyBrowserPartitionPath(profilePath: string): string | null {
  for (const partitionName of LEGACY_BROWSER_PARTITION_NAMES) {
    const partitionPath = Path.join(profilePath, "Partitions", partitionName);
    if (FS.existsSync(partitionPath)) return partitionPath;
  }
  return null;
}

function seedCanonicalBrowserPartition(sourceProfilePath: string, targetProfilePath: string) {
  const sourcePartitionPath = resolveLegacyBrowserPartitionPath(sourceProfilePath);
  if (!sourcePartitionPath) return [];

  const targetPartitionPath = Path.join(
    targetProfilePath,
    "Partitions",
    CANONICAL_BROWSER_PARTITION_NAME,
  );
  const copiedEntries: string[] = [];
  for (const entryName of BROWSER_PARTITION_SEED_ENTRY_NAMES) {
    const sourceEntryPath = Path.join(sourcePartitionPath, entryName);
    const targetEntryPath = Path.join(targetPartitionPath, entryName);
    if (!FS.existsSync(sourceEntryPath) || FS.existsSync(targetEntryPath)) continue;
    FS.mkdirSync(targetPartitionPath, { recursive: true });
    FS.cpSync(sourceEntryPath, targetEntryPath, {
      recursive: true,
      errorOnExist: false,
      force: false,
    });
    copiedEntries.push(entryName);
  }
  return copiedEntries;
}
