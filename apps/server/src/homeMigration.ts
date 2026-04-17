/**
 * FILE: homeMigration.ts
 * Purpose: Imports legacy ~/.t3 state into the new ~/.dpcode home on first startup.
 * Layer: Startup utility
 * Depends on: config path derivation, Effect filesystem/path services, and node:sqlite snapshots
 */
import { DatabaseSync } from "node:sqlite";

import { Data, Effect, FileSystem, Path } from "effect";

import { deriveServerPaths } from "./config";

export const DPCODE_HOME_DIRNAME = ".dpcode";
export const LEGACY_T3_HOME_DIRNAME = ".t3";
const MIGRATIONS_DIRNAME = "migrations";
const LEGACY_IMPORT_MARKER_BASENAME = "import-from-t3-v1.json";

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
    "database" | "keybindings" | "attachments" | "anonymousId"
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

const IMPORTABLE_ARTIFACTS = ["database", "keybindings", "attachments", "anonymousId"] as const;

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
  Effect.try({
    try: () => {
      const escapedTargetPath = targetPath.replaceAll("'", "''");
      const sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
      try {
        sourceDb.exec(`VACUUM INTO '${escapedTargetPath}'`);
      } finally {
        sourceDb.close();
      }
    },
    catch: (cause) =>
      new HomeMigrationError({
        message: `Failed to snapshot legacy sqlite database from ${sourcePath} to ${targetPath}. Close other DP Code processes and retry.`,
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

const cleanUpStagingDir = (stagingBaseDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(stagingBaseDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));
  });

export const migrateLegacyHomeIfNeeded = Effect.fn(function* (input: LegacyHomeMigrationInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalTargetBaseDir = path.resolve(path.join(input.homeDir, DPCODE_HOME_DIRNAME));
  if (path.resolve(input.baseDir) !== canonicalTargetBaseDir) {
    return {
      status: "skipped",
      reason: "non-default-home",
      importedArtifacts: [],
    };
  }

  const legacyBaseDir = path.resolve(path.join(input.homeDir, LEGACY_T3_HOME_DIRNAME));
  if (!(yield* fs.exists(legacyBaseDir))) {
    return {
      status: "skipped",
      reason: "legacy-home-missing",
      importedArtifacts: [],
    };
  }

  const [sourcePaths, targetPaths] = yield* Effect.all(
    [
      deriveServerPaths(legacyBaseDir, input.devUrl),
      deriveServerPaths(canonicalTargetBaseDir, input.devUrl),
    ],
    { concurrency: "unbounded" },
  );
  const markerPath = yield* getLegacyImportMarkerPath(targetPaths.stateDir);
  const marker: MigrationMarker | undefined = yield* readMigrationMarker(markerPath);
  if (marker?.status === "completed") {
    return {
      status: "skipped",
      reason: "marker-already-present",
      importedArtifacts: [],
    };
  }

  const sourceArtifacts = {
    database: yield* fs.exists(sourcePaths.dbPath),
    keybindings: yield* fs.exists(sourcePaths.keybindingsConfigPath),
    attachments: yield* directoryHasEntries(sourcePaths.attachmentsDir),
    anonymousId: yield* fs.exists(sourcePaths.anonymousIdPath),
  } satisfies Record<(typeof IMPORTABLE_ARTIFACTS)[number], boolean>;

  const importedArtifacts = IMPORTABLE_ARTIFACTS.filter((artifact) => sourceArtifacts[artifact]);
  if (importedArtifacts.length === 0) {
    return {
      status: "skipped",
      reason: "legacy-state-missing",
      importedArtifacts: [],
    };
  }

  const targetArtifacts = {
    database: yield* fs.exists(targetPaths.dbPath),
    keybindings: yield* fs.exists(targetPaths.keybindingsConfigPath),
    attachments: yield* directoryHasEntries(targetPaths.attachmentsDir),
    anonymousId: yield* fs.exists(targetPaths.anonymousIdPath),
  } satisfies Record<(typeof IMPORTABLE_ARTIFACTS)[number], boolean>;

  const targetAlreadyInitialized = IMPORTABLE_ARTIFACTS.some(
    (artifact) => targetArtifacts[artifact],
  );
  if (targetAlreadyInitialized && marker?.status !== "in-progress") {
    return {
      status: "skipped",
      reason: "target-already-initialized",
      importedArtifacts: [],
    };
  }

  const stagingBaseDir = path.join(
    input.homeDir,
    `.${DPCODE_HOME_DIRNAME.slice(1)}-migration-${process.pid}-${Date.now()}`,
  );
  const stagingPaths = yield* deriveServerPaths(stagingBaseDir, input.devUrl);
  yield* fs.makeDirectory(stagingPaths.stateDir, { recursive: true });

  const migrateEffect = Effect.gen(function* () {
    const migrationStartedAt = marker?.startedAt ?? new Date().toISOString();

    // Persist the in-progress marker before moving any live artifact so retries can resume safely.
    yield* writeMigrationMarker(markerPath, {
      status: "in-progress",
      sourceBaseDir: legacyBaseDir,
      targetBaseDir: canonicalTargetBaseDir,
      sourceStateDir: sourcePaths.stateDir,
      targetStateDir: targetPaths.stateDir,
      importedArtifacts,
      startedAt: migrationStartedAt,
      migratedAt: marker?.migratedAt ?? migrationStartedAt,
      notes: [
        "Legacy ~/.t3 data is being imported into ~/.dpcode.",
        "If startup stops midway, the next launch resumes this import instead of starting from scratch.",
      ],
    });

    const pendingArtifacts = new Set(
      IMPORTABLE_ARTIFACTS.filter(
        (artifact) => sourceArtifacts[artifact] && !targetArtifacts[artifact],
      ),
    );

    if (pendingArtifacts.has("database")) {
      yield* snapshotSqliteDatabase(sourcePaths.dbPath, stagingPaths.dbPath);
    }
    if (pendingArtifacts.has("keybindings")) {
      yield* stageFileCopy(sourcePaths.keybindingsConfigPath, stagingPaths.keybindingsConfigPath);
    }
    if (pendingArtifacts.has("attachments")) {
      yield* fs.copy(sourcePaths.attachmentsDir, stagingPaths.attachmentsDir);
    }
    if (pendingArtifacts.has("anonymousId")) {
      yield* stageFileCopy(sourcePaths.anonymousIdPath, stagingPaths.anonymousIdPath);
    }

    // Merge imported state into the new home without touching any target logs already created.
    yield* fs.makeDirectory(targetPaths.stateDir, { recursive: true });
    if (pendingArtifacts.has("database")) {
      yield* moveStagedArtifact(stagingPaths.dbPath, targetPaths.dbPath);
    }
    if (pendingArtifacts.has("keybindings")) {
      yield* moveStagedArtifact(
        stagingPaths.keybindingsConfigPath,
        targetPaths.keybindingsConfigPath,
      );
    }
    if (pendingArtifacts.has("attachments")) {
      yield* moveStagedArtifact(stagingPaths.attachmentsDir, targetPaths.attachmentsDir);
    }
    if (pendingArtifacts.has("anonymousId")) {
      yield* moveStagedArtifact(stagingPaths.anonymousIdPath, targetPaths.anonymousIdPath);
    }

    yield* writeMigrationMarker(markerPath, {
      status: "completed",
      sourceBaseDir: legacyBaseDir,
      targetBaseDir: canonicalTargetBaseDir,
      sourceStateDir: sourcePaths.stateDir,
      targetStateDir: targetPaths.stateDir,
      importedArtifacts,
      startedAt: migrationStartedAt,
      migratedAt: new Date().toISOString(),
      notes: [
        "Legacy ~/.t3 data was imported into ~/.dpcode.",
        "Existing legacy worktree directories were left in place and are still referenced by absolute path.",
      ],
    });

    yield* Effect.logInfo("imported legacy T3 state into DP Code home", {
      sourceStateDir: sourcePaths.stateDir,
      targetStateDir: targetPaths.stateDir,
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
            message: "Failed to import legacy ~/.t3 state into ~/.dpcode.",
            cause: error,
          }),
    ),
  );
});
