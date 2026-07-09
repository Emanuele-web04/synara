/**
 * FILE: homeMigration.ts
 * Purpose: Imports legacy ~/.dpcode or ~/.t3 state into the new ~/.synara home on first startup.
 * Layer: Startup utility
 * Depends on: config path derivation, Effect filesystem/path services, and sqlite snapshots
 */
import { Data, Effect, FileSystem, Path } from "effect";

import { deriveServerPaths, type ServerDerivedPaths } from "./config";

export const SYNARA_HOME_DIRNAME = ".synara";
export const LEGACY_DPCODE_HOME_DIRNAME = ".dpcode";
export const LEGACY_T3_HOME_DIRNAME = ".t3";
const MIGRATIONS_DIRNAME = "migrations";
const LEGACY_IMPORT_MARKER_BASENAME = "import-from-legacy-home-v2.json";

export class HomeMigrationError extends Data.TaggedError("HomeMigrationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type MigrationMarkerStatus = "in-progress" | "completed";

export interface LegacyHomeMigrationResult {
  readonly status: "skipped" | "migrated";
  readonly reason:
    | "non-default-home"
    | "legacy-home-missing"
    | "legacy-state-missing"
    | "target-already-initialized"
    | "marker-already-present"
    | "migrated";
  readonly importedArtifacts: ReadonlyArray<
    | "database"
    | "settings"
    | "keybindings"
    | "attachments"
    | "secrets"
    | "anonymousId"
    | "environmentId"
  >;
}

interface LegacyHomeMigrationInput {
  readonly baseDir: string;
  readonly homeDir: string;
  readonly devUrl: URL | undefined;
}

interface MigrationMarker {
  readonly status: MigrationMarkerStatus;
  readonly sourceBaseDir: string;
  readonly targetBaseDir: string;
  readonly sourceStateDir: string;
  readonly targetStateDir: string;
  readonly importedArtifacts: ReadonlyArray<string>;
  readonly startedAt: string;
  readonly migratedAt: string;
  readonly notes: ReadonlyArray<string>;
}

const IMPORTABLE_ARTIFACTS = [
  "database",
  "settings",
  "keybindings",
  "attachments",
  "secrets",
  "anonymousId",
  "environmentId",
] as const;
const LEGACY_HOME_DIRNAMES = [LEGACY_DPCODE_HOME_DIRNAME, LEGACY_T3_HOME_DIRNAME] as const;
type ImportableArtifact = (typeof IMPORTABLE_ARTIFACTS)[number];
type LegacyHomeSnapshot = {
  readonly dirname: (typeof LEGACY_HOME_DIRNAMES)[number];
  readonly baseDir: string;
  readonly paths: ServerDerivedPaths;
  readonly artifacts: Record<ImportableArtifact, boolean>;
};

interface SnapshotSqliteDatabase {
  readonly exec: (sql: string) => unknown;
  readonly close: () => unknown;
}

const importRuntimeModule = (specifier: string): Promise<unknown> =>
  Function("specifier", "return import(specifier)")(specifier) as Promise<unknown>;
const openReadOnlySnapshotDatabase = async (
  sourcePath: string,
): Promise<SnapshotSqliteDatabase> => {
  if (process.versions.bun !== undefined) {
    const { Database } = (await importRuntimeModule("bun:sqlite")) as {
      readonly Database: new (
        path: string,
        options: { readonly: boolean },
      ) => SnapshotSqliteDatabase;
    };
    return new Database(sourcePath, { readonly: true });
  }

  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(sourcePath, { readOnly: true });
};

const writeMigrationMarker = (markerPath: string, marker: MigrationMarker) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(markerPath), { recursive: true });
    yield* fs.writeFileString(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  });

type RawMigrationMarker = {
  readonly status?: unknown;
  readonly sourceBaseDir?: unknown;
  readonly targetBaseDir?: unknown;
  readonly sourceStateDir?: unknown;
  readonly targetStateDir?: unknown;
  readonly importedArtifacts?: unknown;
  readonly startedAt?: unknown;
  readonly migratedAt?: unknown;
  readonly notes?: unknown;
};

const parseMigrationMarker = (rawContents: string, markerPath: string) =>
  Effect.try({
    try: () => JSON.parse(rawContents) as RawMigrationMarker,
    catch: (cause) =>
      new HomeMigrationError({
        message: `Failed to read migration marker at ${markerPath}.`,
        cause,
      }),
  });

// Reads both the new resumable marker shape and the older "completed only" marker format.
const readMigrationMarker = (markerPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(markerPath))) {
      return undefined;
    }

    const raw = yield* parseMigrationMarker(yield* fs.readFileString(markerPath), markerPath);

    const importedArtifacts = Array.isArray(raw.importedArtifacts)
      ? raw.importedArtifacts.filter((value): value is string => typeof value === "string")
      : [];
    const notes = Array.isArray(raw.notes)
      ? raw.notes.filter((value): value is string => typeof value === "string")
      : [];
    const migratedAt =
      typeof raw.migratedAt === "string" ? raw.migratedAt : new Date().toISOString();

    return {
      status: raw.status === "in-progress" ? "in-progress" : "completed",
      sourceBaseDir: typeof raw.sourceBaseDir === "string" ? raw.sourceBaseDir : "",
      targetBaseDir: typeof raw.targetBaseDir === "string" ? raw.targetBaseDir : "",
      sourceStateDir: typeof raw.sourceStateDir === "string" ? raw.sourceStateDir : "",
      targetStateDir: typeof raw.targetStateDir === "string" ? raw.targetStateDir : "",
      importedArtifacts,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : migratedAt,
      migratedAt,
      notes,
    } satisfies MigrationMarker;
  });

const snapshotSqliteDatabase = (sourcePath: string, targetPath: string) =>
  Effect.tryPromise({
    try: async () => {
      const escapedTargetPath = targetPath.replaceAll("'", "''");
      const sourceDb = await openReadOnlySnapshotDatabase(sourcePath);
      try {
        sourceDb.exec(`VACUUM INTO '${escapedTargetPath}'`);
      } finally {
        sourceDb.close();
      }
    },
    catch: (cause) =>
      new HomeMigrationError({
        message: `Failed to snapshot legacy sqlite database from ${sourcePath} to ${targetPath}. Close other Synara processes and retry.`,
        cause,
      }),
  });

const directoryHasEntries = (directoryPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(directoryPath))) {
      return false;
    }
    return (yield* fs.readDirectory(directoryPath)).length > 0;
  });

const directoryHasMissingEntries = (sourceDirectory: string, targetDirectory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourceDirectory))) {
      return false;
    }
    if (!(yield* fs.exists(targetDirectory))) {
      return (yield* fs.readDirectory(sourceDirectory)).length > 0;
    }

    const pendingDirectories = [[sourceDirectory, targetDirectory] as const];
    while (pendingDirectories.length > 0) {
      const current = pendingDirectories.pop();
      if (!current) {
        break;
      }
      const [currentSourceDirectory, currentTargetDirectory] = current;
      for (const entry of yield* fs.readDirectory(currentSourceDirectory)) {
        const sourcePath = path.join(currentSourceDirectory, entry);
        const targetPath = path.join(currentTargetDirectory, entry);
        if (!(yield* fs.exists(targetPath))) {
          return true;
        }

        const sourceInfo = yield* fs.stat(sourcePath);
        const targetInfo = yield* fs.stat(targetPath);
        if (sourceInfo.type === "Directory" && targetInfo.type === "Directory") {
          pendingDirectories.push([sourcePath, targetPath]);
        }
      }
    }

    return false;
  });

export const getLegacyImportMarkerPath = Effect.fn(function* (stateDir: string) {
  const path = yield* Path.Path;
  return path.join(stateDir, MIGRATIONS_DIRNAME, LEGACY_IMPORT_MARKER_BASENAME);
});

const stageFileCopy = (sourcePath: string, targetPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
    yield* fs.copyFile(sourcePath, targetPath);
  });

const moveStagedArtifact = (sourcePath: string, targetPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (yield* fs.exists(targetPath)) {
      return yield* new HomeMigrationError({
        message: `Refusing to overwrite existing migrated artifact at ${targetPath}.`,
      });
    }
    yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
    yield* fs.rename(sourcePath, targetPath);
  });

// On retries, fills directory entries that an earlier importer omitted without
// replacing credentials or attachments already created in the Synara home.
const mergeMissingDirectoryEntries = (sourceDirectory: string, targetDirectory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(targetDirectory, { recursive: true });

    const pendingDirectories = [[sourceDirectory, targetDirectory] as const];
    while (pendingDirectories.length > 0) {
      const current = pendingDirectories.pop();
      if (!current) {
        break;
      }
      const [currentSourceDirectory, currentTargetDirectory] = current;
      for (const entry of yield* fs.readDirectory(currentSourceDirectory)) {
        const sourcePath = path.join(currentSourceDirectory, entry);
        const targetPath = path.join(currentTargetDirectory, entry);
        if (!(yield* fs.exists(targetPath))) {
          yield* fs.copy(sourcePath, targetPath, {
            overwrite: false,
            preserveTimestamps: true,
          });
          continue;
        }

        const sourceInfo = yield* fs.stat(sourcePath);
        const targetInfo = yield* fs.stat(targetPath);
        if (sourceInfo.type === "Directory" && targetInfo.type === "Directory") {
          pendingDirectories.push([sourcePath, targetPath]);
        }
      }
    }
  });

const cleanUpStagingDir = (stagingBaseDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(stagingBaseDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));
  });

export const migrateLegacyHomeIfNeeded = Effect.fn(function* (input: LegacyHomeMigrationInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalTargetBaseDir = path.resolve(path.join(input.homeDir, SYNARA_HOME_DIRNAME));
  if (path.resolve(input.baseDir) !== canonicalTargetBaseDir) {
    return {
      status: "skipped",
      reason: "non-default-home",
      importedArtifacts: [],
    };
  }

  const targetPaths = yield* deriveServerPaths(canonicalTargetBaseDir, input.devUrl);
  const markerPath = yield* getLegacyImportMarkerPath(targetPaths.stateDir);
  const marker: MigrationMarker | undefined = yield* readMigrationMarker(markerPath);

  const legacyHomes: LegacyHomeSnapshot[] = [];
  let sawLegacyHome = false;

  for (const dirname of LEGACY_HOME_DIRNAMES) {
    const legacyBaseDir = path.resolve(path.join(input.homeDir, dirname));
    if (!(yield* fs.exists(legacyBaseDir))) {
      continue;
    }
    sawLegacyHome = true;
    const sourcePaths = yield* deriveServerPaths(legacyBaseDir, input.devUrl);
    const sourceArtifacts = {
      database: yield* fs.exists(sourcePaths.dbPath),
      settings: yield* fs.exists(sourcePaths.settingsPath),
      keybindings: yield* fs.exists(sourcePaths.keybindingsConfigPath),
      attachments: yield* directoryHasEntries(sourcePaths.attachmentsDir),
      secrets: yield* directoryHasEntries(sourcePaths.secretsDir),
      anonymousId: yield* fs.exists(sourcePaths.anonymousIdPath),
      environmentId: yield* fs.exists(sourcePaths.environmentIdPath),
    } satisfies Record<ImportableArtifact, boolean>;
    if (IMPORTABLE_ARTIFACTS.some((artifact) => sourceArtifacts[artifact])) {
      legacyHomes.push({
        dirname,
        baseDir: legacyBaseDir,
        paths: sourcePaths,
        artifacts: sourceArtifacts,
      });
    }
  }

  if (legacyHomes.length === 0) {
    if (marker?.status === "completed") {
      return {
        status: "skipped",
        reason: "marker-already-present",
        importedArtifacts: [],
      };
    }
    return {
      status: "skipped",
      reason: sawLegacyHome ? "legacy-state-missing" : "legacy-home-missing",
      importedArtifacts: [],
    };
  }

  // Resolve each artifact independently so a partial ~/.dpcode home does not
  // block importing older but still valuable ~/.t3 state.
  const sourceByArtifact = new Map<ImportableArtifact, LegacyHomeSnapshot>();
  for (const artifact of IMPORTABLE_ARTIFACTS) {
    const source = legacyHomes.find((legacyHome) => legacyHome.artifacts[artifact]);
    if (source) {
      sourceByArtifact.set(artifact, source);
    }
  }

  const importedArtifacts = IMPORTABLE_ARTIFACTS.filter((artifact) =>
    sourceByArtifact.has(artifact),
  );
  if (importedArtifacts.length === 0) {
    return {
      status: "skipped",
      reason: "legacy-state-missing",
      importedArtifacts: [],
    };
  }

  const targetArtifacts = {
    database: yield* fs.exists(targetPaths.dbPath),
    settings: yield* fs.exists(targetPaths.settingsPath),
    keybindings: yield* fs.exists(targetPaths.keybindingsConfigPath),
    attachments: yield* directoryHasEntries(targetPaths.attachmentsDir),
    secrets: yield* directoryHasEntries(targetPaths.secretsDir),
    anonymousId: yield* fs.exists(targetPaths.anonymousIdPath),
    environmentId: yield* fs.exists(targetPaths.environmentIdPath),
  } satisfies Record<ImportableArtifact, boolean>;

  const pendingArtifacts = new Set<ImportableArtifact>();
  for (const artifact of importedArtifacts) {
    const source = sourceByArtifact.get(artifact);
    if (!source) {
      continue;
    }
    if (artifact === "attachments") {
      if (
        yield* directoryHasMissingEntries(source.paths.attachmentsDir, targetPaths.attachmentsDir)
      ) {
        pendingArtifacts.add(artifact);
      }
      continue;
    }
    if (artifact === "secrets") {
      if (yield* directoryHasMissingEntries(source.paths.secretsDir, targetPaths.secretsDir)) {
        pendingArtifacts.add(artifact);
      }
      continue;
    }
    if (!targetArtifacts[artifact]) {
      pendingArtifacts.add(artifact);
    }
  }

  if (marker?.status === "completed" && pendingArtifacts.size === 0) {
    return {
      status: "skipped",
      reason: "marker-already-present",
      importedArtifacts: [],
    };
  }

  // A database or attachment set represents an authoritative initialized home.
  // Identity/credential files can be created before meaningful state exists, so
  // they must not prevent the bridge from importing the remaining user data.
  const targetAlreadyInitialized = targetArtifacts.database || targetArtifacts.attachments;
  if (targetAlreadyInitialized && marker === undefined) {
    return {
      status: "skipped",
      reason: "target-already-initialized",
      importedArtifacts: [],
    };
  }

  const stagingBaseDir = path.join(
    input.homeDir,
    `.${SYNARA_HOME_DIRNAME.slice(1)}-migration-${process.pid}-${Date.now()}`,
  );
  const stagingPaths = yield* deriveServerPaths(stagingBaseDir, input.devUrl);
  yield* fs.makeDirectory(stagingPaths.stateDir, { recursive: true });

  const migrateEffect = Effect.gen(function* () {
    const migrationStartedAt = marker?.startedAt ?? new Date().toISOString();
    const usedLegacyHomes = legacyHomes.filter((legacyHome) =>
      importedArtifacts.some((artifact) => sourceByArtifact.get(artifact) === legacyHome),
    );
    const [primaryLegacyHome] = usedLegacyHomes;
    if (!primaryLegacyHome) {
      return yield* new HomeMigrationError({
        message: "No legacy home was selected for import.",
      });
    }
    const sourceDisplayName =
      usedLegacyHomes.length === 1
        ? `~/${primaryLegacyHome.dirname}`
        : `legacy homes (${usedLegacyHomes
            .map((legacyHome) => `~/${legacyHome.dirname}`)
            .join(", ")})`;
    const targetDisplayName = `~/${SYNARA_HOME_DIRNAME}`;

    // Persist the in-progress marker before moving any live artifact so retries can resume safely.
    yield* writeMigrationMarker(markerPath, {
      status: "in-progress",
      sourceBaseDir: primaryLegacyHome.baseDir,
      targetBaseDir: canonicalTargetBaseDir,
      sourceStateDir: primaryLegacyHome.paths.stateDir,
      targetStateDir: targetPaths.stateDir,
      importedArtifacts,
      startedAt: migrationStartedAt,
      migratedAt: marker?.migratedAt ?? migrationStartedAt,
      notes: [
        `Legacy ${sourceDisplayName} data is being imported into ${targetDisplayName}.`,
        "If startup stops midway, the next launch resumes this import instead of starting from scratch.",
      ],
    });

    if (pendingArtifacts.has("database")) {
      const source = sourceByArtifact.get("database");
      if (source) {
        yield* snapshotSqliteDatabase(source.paths.dbPath, stagingPaths.dbPath);
      }
    }
    if (pendingArtifacts.has("settings")) {
      const source = sourceByArtifact.get("settings");
      if (source) {
        yield* stageFileCopy(source.paths.settingsPath, stagingPaths.settingsPath);
      }
    }
    if (pendingArtifacts.has("keybindings")) {
      const source = sourceByArtifact.get("keybindings");
      if (source) {
        yield* stageFileCopy(
          source.paths.keybindingsConfigPath,
          stagingPaths.keybindingsConfigPath,
        );
      }
    }
    if (pendingArtifacts.has("attachments")) {
      const source = sourceByArtifact.get("attachments");
      if (source) {
        yield* fs.copy(source.paths.attachmentsDir, stagingPaths.attachmentsDir);
      }
    }
    if (pendingArtifacts.has("secrets")) {
      const source = sourceByArtifact.get("secrets");
      if (source) {
        yield* fs.copy(source.paths.secretsDir, stagingPaths.secretsDir);
      }
    }
    if (pendingArtifacts.has("anonymousId")) {
      const source = sourceByArtifact.get("anonymousId");
      if (source) {
        yield* stageFileCopy(source.paths.anonymousIdPath, stagingPaths.anonymousIdPath);
      }
    }
    if (pendingArtifacts.has("environmentId")) {
      const source = sourceByArtifact.get("environmentId");
      if (source) {
        yield* stageFileCopy(source.paths.environmentIdPath, stagingPaths.environmentIdPath);
      }
    }

    // Merge imported state into the new home without touching any target logs already created.
    yield* fs.makeDirectory(targetPaths.stateDir, { recursive: true });
    if (pendingArtifacts.has("database")) {
      yield* moveStagedArtifact(stagingPaths.dbPath, targetPaths.dbPath);
    }
    if (pendingArtifacts.has("settings")) {
      yield* moveStagedArtifact(stagingPaths.settingsPath, targetPaths.settingsPath);
    }
    if (pendingArtifacts.has("keybindings")) {
      yield* moveStagedArtifact(
        stagingPaths.keybindingsConfigPath,
        targetPaths.keybindingsConfigPath,
      );
    }
    if (pendingArtifacts.has("attachments")) {
      yield* mergeMissingDirectoryEntries(stagingPaths.attachmentsDir, targetPaths.attachmentsDir);
    }
    if (pendingArtifacts.has("secrets")) {
      yield* mergeMissingDirectoryEntries(stagingPaths.secretsDir, targetPaths.secretsDir);
    }
    if (pendingArtifacts.has("anonymousId")) {
      yield* moveStagedArtifact(stagingPaths.anonymousIdPath, targetPaths.anonymousIdPath);
    }
    if (pendingArtifacts.has("environmentId")) {
      yield* moveStagedArtifact(stagingPaths.environmentIdPath, targetPaths.environmentIdPath);
    }

    yield* writeMigrationMarker(markerPath, {
      status: "completed",
      sourceBaseDir: primaryLegacyHome.baseDir,
      targetBaseDir: canonicalTargetBaseDir,
      sourceStateDir: primaryLegacyHome.paths.stateDir,
      targetStateDir: targetPaths.stateDir,
      importedArtifacts,
      startedAt: migrationStartedAt,
      migratedAt: new Date().toISOString(),
      notes: [
        `Legacy ${sourceDisplayName} data was imported into ${targetDisplayName}.`,
        "Existing legacy worktree directories were left in place and are still referenced by absolute path.",
      ],
    });

    yield* Effect.logInfo("imported legacy state into Synara home", {
      sourceStateDir: primaryLegacyHome.paths.stateDir,
      targetStateDir: targetPaths.stateDir,
      sourceHomeDirname: primaryLegacyHome.dirname,
      sourceHomeDirnames: usedLegacyHomes.map((legacyHome) => legacyHome.dirname),
      importedArtifacts,
    });

    return {
      status: "migrated",
      reason: "migrated",
      importedArtifacts,
    } satisfies LegacyHomeMigrationResult;
  });

  return yield* migrateEffect.pipe(
    Effect.ensuring(cleanUpStagingDir(stagingBaseDir)),
    Effect.mapError((error) =>
      error instanceof HomeMigrationError
        ? error
        : new HomeMigrationError({
            message: "Failed to import legacy state into ~/.synara.",
            cause: error,
          }),
    ),
  );
});
