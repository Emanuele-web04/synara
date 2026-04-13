/**
 * FILE: homeMigration.test.ts
 * Purpose: Verifies first-run import and resume behavior for the ~/.t3 -> ~/.dpcode migration.
 * Layer: Server startup tests
 * Depends on: deriveServerPaths, node:sqlite fixtures, and the migration marker contract
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { deriveServerPaths } from "./config";
import {
  DPCODE_HOME_DIRNAME,
  getLegacyImportMarkerPath,
  LEGACY_T3_HOME_DIRNAME,
  migrateLegacyHomeIfNeeded,
} from "./homeMigration";

// Creates the minimal sqlite state the migration needs to prove DB contents moved correctly.
const createProjectDb = (dbPath: string, title: string) => {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY, title TEXT);");
    const statement = db.prepare("INSERT INTO projects(id, title) VALUES (?, ?);");
    statement.run("project-1", title);
  } finally {
    db.close();
  }
};

// Reads back the migrated row so tests can assert which home currently owns the DB.
const readProjectTitle = (dbPath: string): string | undefined => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT title FROM projects WHERE id = ?").get("project-1") as
      | { readonly title?: string }
      | undefined;
    return row?.title;
  } finally {
    db.close();
  }
};

const readMarker = (markerPath: string) =>
  JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
    readonly status: "in-progress" | "completed";
    readonly importedArtifacts: ReadonlyArray<string>;
  };

it.layer(NodeServices.layer)("homeMigration", (it) => {
  it.effect("imports legacy userdata into the new default home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, DPCODE_HOME_DIRNAME);
      const legacyPaths = yield* deriveServerPaths(legacyBaseDir, undefined);
      const targetPaths = yield* deriveServerPaths(targetBaseDir, undefined);

      fs.mkdirSync(legacyPaths.attachmentsDir, { recursive: true });
      fs.writeFileSync(
        legacyPaths.keybindingsConfigPath,
        '[{"key":"mod+j","command":"terminal.toggle"}]\n',
      );
      fs.writeFileSync(legacyPaths.anonymousIdPath, "legacy-anon-id");
      fs.writeFileSync(path.join(legacyPaths.attachmentsDir, "readme.txt"), "legacy attachment");
      createProjectDb(legacyPaths.dbPath, "Legacy project");

      const result = yield* migrateLegacyHomeIfNeeded({
        baseDir: targetBaseDir,
        homeDir: tempHome,
        devUrl: undefined,
      });

      assert.deepStrictEqual(result, {
        status: "migrated",
        reason: "migrated",
        importedArtifacts: ["database", "keybindings", "attachments", "anonymousId"],
      });
      assert.equal(readProjectTitle(targetPaths.dbPath), "Legacy project");
      assert.equal(
        fs.readFileSync(targetPaths.keybindingsConfigPath, "utf8").trim(),
        '[{"key":"mod+j","command":"terminal.toggle"}]',
      );
      assert.equal(fs.readFileSync(targetPaths.anonymousIdPath, "utf8"), "legacy-anon-id");
      assert.equal(
        fs.readFileSync(path.join(targetPaths.attachmentsDir, "readme.txt"), "utf8"),
        "legacy attachment",
      );
      assert.isTrue(fs.existsSync(legacyPaths.dbPath));

      const markerPath = yield* getLegacyImportMarkerPath(targetPaths.stateDir);
      assert.isTrue(yield* fileSystem.exists(markerPath));
      assert.equal(readMarker(markerPath).status, "completed");
    }),
  );

  it.effect("preserves target logs while importing legacy state", () =>
    Effect.gen(function* () {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, DPCODE_HOME_DIRNAME);
      const legacyPaths = yield* deriveServerPaths(legacyBaseDir, undefined);
      const targetPaths = yield* deriveServerPaths(targetBaseDir, undefined);

      fs.mkdirSync(legacyPaths.attachmentsDir, { recursive: true });
      fs.writeFileSync(legacyPaths.anonymousIdPath, "legacy-anon-id");
      createProjectDb(legacyPaths.dbPath, "Legacy project");

      fs.mkdirSync(targetPaths.logsDir, { recursive: true });
      fs.writeFileSync(path.join(targetPaths.logsDir, "desktop.log"), "new target log");

      yield* migrateLegacyHomeIfNeeded({
        baseDir: targetBaseDir,
        homeDir: tempHome,
        devUrl: undefined,
      });

      assert.equal(readProjectTitle(targetPaths.dbPath), "Legacy project");
      assert.equal(
        fs.readFileSync(path.join(targetPaths.logsDir, "desktop.log"), "utf8"),
        "new target log",
      );
    }),
  );

  it.effect("skips the import when the target home already owns state", () =>
    Effect.gen(function* () {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, DPCODE_HOME_DIRNAME);
      const legacyPaths = yield* deriveServerPaths(legacyBaseDir, undefined);
      const targetPaths = yield* deriveServerPaths(targetBaseDir, undefined);

      fs.mkdirSync(path.dirname(legacyPaths.dbPath), { recursive: true });
      createProjectDb(legacyPaths.dbPath, "Legacy project");
      fs.mkdirSync(path.dirname(targetPaths.dbPath), { recursive: true });
      createProjectDb(targetPaths.dbPath, "Target project");

      const result = yield* migrateLegacyHomeIfNeeded({
        baseDir: targetBaseDir,
        homeDir: tempHome,
        devUrl: undefined,
      });

      assert.deepStrictEqual(result, {
        status: "skipped",
        reason: "target-already-initialized",
        importedArtifacts: [],
      });
      assert.equal(readProjectTitle(targetPaths.dbPath), "Target project");
    }),
  );

  it.effect("resumes an interrupted migration instead of skipping partially imported state", () =>
    Effect.gen(function* () {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, DPCODE_HOME_DIRNAME);
      const legacyPaths = yield* deriveServerPaths(legacyBaseDir, undefined);
      const targetPaths = yield* deriveServerPaths(targetBaseDir, undefined);
      const markerPath = yield* getLegacyImportMarkerPath(targetPaths.stateDir);

      fs.mkdirSync(legacyPaths.attachmentsDir, { recursive: true });
      fs.writeFileSync(
        legacyPaths.keybindingsConfigPath,
        '[{"key":"mod+j","command":"terminal.toggle"}]\n',
      );
      fs.writeFileSync(legacyPaths.anonymousIdPath, "legacy-anon-id");
      createProjectDb(legacyPaths.dbPath, "Legacy project");

      // Simulate a previous run that already moved the DB before failing on later artifacts.
      fs.mkdirSync(path.dirname(targetPaths.dbPath), { recursive: true });
      fs.copyFileSync(legacyPaths.dbPath, targetPaths.dbPath);
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify(
          {
            status: "in-progress",
            sourceBaseDir: legacyBaseDir,
            targetBaseDir,
            sourceStateDir: legacyPaths.stateDir,
            targetStateDir: targetPaths.stateDir,
            importedArtifacts: ["database", "keybindings", "anonymousId"],
            startedAt: new Date().toISOString(),
            migratedAt: new Date().toISOString(),
            notes: ["resume me"],
          },
          null,
          2,
        )}\n`,
      );

      const result = yield* migrateLegacyHomeIfNeeded({
        baseDir: targetBaseDir,
        homeDir: tempHome,
        devUrl: undefined,
      });

      assert.deepStrictEqual(result, {
        status: "migrated",
        reason: "migrated",
        importedArtifacts: ["database", "keybindings", "anonymousId"],
      });
      assert.equal(readProjectTitle(targetPaths.dbPath), "Legacy project");
      assert.equal(
        fs.readFileSync(targetPaths.keybindingsConfigPath, "utf8").trim(),
        '[{"key":"mod+j","command":"terminal.toggle"}]',
      );
      assert.equal(fs.readFileSync(targetPaths.anonymousIdPath, "utf8"), "legacy-anon-id");
      assert.equal(readMarker(markerPath).status, "completed");
    }),
  );

  it.effect("imports legacy dev state when a dev URL is active", () =>
    Effect.gen(function* () {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dpcode-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, DPCODE_HOME_DIRNAME);
      const devUrl = new URL("http://127.0.0.1:5173");
      const legacyPaths = yield* deriveServerPaths(legacyBaseDir, devUrl);
      const targetPaths = yield* deriveServerPaths(targetBaseDir, devUrl);

      fs.mkdirSync(path.dirname(legacyPaths.keybindingsConfigPath), { recursive: true });
      fs.writeFileSync(
        legacyPaths.keybindingsConfigPath,
        '[{"key":"mod+k","command":"sidebar.search"}]\n',
      );

      const result = yield* migrateLegacyHomeIfNeeded({
        baseDir: targetBaseDir,
        homeDir: tempHome,
        devUrl,
      });

      assert.deepStrictEqual(result, {
        status: "migrated",
        reason: "migrated",
        importedArtifacts: ["keybindings"],
      });
      assert.equal(
        fs.readFileSync(targetPaths.keybindingsConfigPath, "utf8").trim(),
        '[{"key":"mod+k","command":"sidebar.search"}]',
      );
    }),
  );
});
