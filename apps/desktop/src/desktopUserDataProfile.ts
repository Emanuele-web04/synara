// FILE: desktopUserDataProfile.ts
// Purpose: Resolves Synara's Electron userData paths and completes bridge profile repair.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const DEV_USER_DATA_DIR_NAME = "synara-dev";
const PROD_USER_DATA_DIR_NAME = "synara";
const BRIDGE_PROFILE_MANIFEST_FILE_NAME = "synara-profile-seed.json";
const CANONICAL_BROWSER_PARTITION_NAME = "synara-browser";
const BROWSER_PARTITION_SEED_ENTRY_GROUPS = [
  ["Cookies", "Cookies-journal"],
  ["Local Storage"],
  ["IndexedDB"],
  ["Session Storage"],
  ["WebStorage"],
  ["Service Worker"],
  ["Preferences"],
  ["Network Persistent State"],
  ["TransportSecurity"],
  ["Trust Tokens", "Trust Tokens-journal"],
  ["SharedStorage", "SharedStorage-wal"],
  ["shared_proto_db"],
] as const;
const BROWSER_PARTITION_SEED_ENTRY_NAMES = BROWSER_PARTITION_SEED_ENTRY_GROUPS.flat();

export interface BrowserProfileBridgeRepairResult {
  readonly status: "repaired" | "not-needed" | "bridge-unavailable" | "repair-failed";
  readonly sourcePath: string | null;
  readonly targetPath: string;
  readonly copiedEntries: readonly string[];
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

function readBridgeProfileSourcePath(targetPath: string): string | null {
  const manifestPath = Path.join(targetPath, BRIDGE_PROFILE_MANIFEST_FILE_NAME);
  if (!FS.existsSync(manifestPath)) return null;

  let parsed: { readonly sourcePath?: unknown };
  try {
    parsed = JSON.parse(FS.readFileSync(manifestPath, "utf8")) as {
      readonly sourcePath?: unknown;
    };
  } catch {
    return null;
  }
  if (typeof parsed.sourcePath !== "string" || !Path.isAbsolute(parsed.sourcePath)) {
    return null;
  }

  const sourcePath = Path.resolve(parsed.sourcePath);
  const resolvedTargetPath = Path.resolve(targetPath);
  if (
    sourcePath === resolvedTargetPath ||
    Path.dirname(sourcePath) !== Path.dirname(resolvedTargetPath)
  ) {
    return null;
  }
  return sourcePath;
}

function findBridgeBrowserPartitionPaths(sourceProfilePath: string): string[] {
  const partitionsPath = Path.join(sourceProfilePath, "Partitions");
  if (!FS.existsSync(partitionsPath)) return [];

  return FS.readdirSync(partitionsPath, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.endsWith("-browser") &&
        entry.name !== CANONICAL_BROWSER_PARTITION_NAME,
    )
    .map((entry) => Path.join(partitionsPath, entry.name))
    .filter((partitionPath) =>
      BROWSER_PARTITION_SEED_ENTRY_NAMES.some((entryName) =>
        FS.existsSync(Path.join(partitionPath, entryName)),
      ),
    )
    .sort((left, right) => FS.statSync(right).mtimeMs - FS.statSync(left).mtimeMs);
}

/**
 * Finishes any browser-partition copy described by the compatibility bridge.
 *
 * The bridge manifest identifies the exact sibling profile that supplied the Synara profile.
 * Discovering its `*-browser` partition from that trusted path avoids shipping predecessor names
 * while still repairing cookies or storage entries that were absent during the first bridge run.
 */
export function repairBrowserProfileFromBridgeManifest(
  targetPath: string,
): BrowserProfileBridgeRepairResult {
  let sourcePath: string | null = null;
  try {
    sourcePath = readBridgeProfileSourcePath(targetPath);
    if (!sourcePath || !FS.existsSync(sourcePath)) {
      return {
        status: "bridge-unavailable",
        sourcePath,
        targetPath,
        copiedEntries: [],
      };
    }

    const sourcePartitionPath = findBridgeBrowserPartitionPaths(sourcePath)[0];
    if (!sourcePartitionPath) {
      return {
        status: "not-needed",
        sourcePath,
        targetPath,
        copiedEntries: [],
      };
    }

    const targetPartitionPath = Path.join(
      targetPath,
      "Partitions",
      CANONICAL_BROWSER_PARTITION_NAME,
    );
    const copiedEntries: string[] = [];
    for (const entryGroup of BROWSER_PARTITION_SEED_ENTRY_GROUPS) {
      const baseEntryName = entryGroup[0];
      if (!FS.existsSync(Path.join(sourcePartitionPath, baseEntryName))) continue;
      if (
        entryGroup.some((entryName) => FS.existsSync(Path.join(targetPartitionPath, entryName)))
      ) {
        continue;
      }

      const sourceEntryNames = entryGroup.filter((entryName) =>
        FS.existsSync(Path.join(sourcePartitionPath, entryName)),
      );
      FS.mkdirSync(targetPartitionPath, { recursive: true });
      for (const entryName of sourceEntryNames) {
        FS.cpSync(
          Path.join(sourcePartitionPath, entryName),
          Path.join(targetPartitionPath, entryName),
          {
            recursive: true,
            errorOnExist: false,
            force: false,
          },
        );
        copiedEntries.push(entryName);
      }
    }

    return {
      status: copiedEntries.length > 0 ? "repaired" : "not-needed",
      sourcePath,
      targetPath,
      copiedEntries,
    };
  } catch (error) {
    return {
      status: "repair-failed",
      sourcePath,
      targetPath,
      copiedEntries: [],
      error,
    };
  }
}
