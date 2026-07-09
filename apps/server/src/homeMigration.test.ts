/**
 * FILE: homeMigration.test.ts
 * Purpose: Verifies first-run import and resume behavior into the ~/.synara home.
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
  LEGACY_DPCODE_HOME_DIRNAME,
  getLegacyImportMarkerPath,
  LEGACY_T3_HOME_DIRNAME,
  migrateLegacyHomeIfNeeded,
  SYNARA_HOME_DIRNAME,
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
  it.effect("imports legacy dpcode userdata into the Synara default home", () =>
    Effect.gen(function* () {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "synara-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_DPCODE_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, SYNARA_HOME_DIRNAME);
      const legacyPaths = yield* deriveServerPaths(legacyBaseDir, undefined);
      const targetPaths = yield* deriveServerPaths(targetBaseDir, undefined);

      fs.mkdirSync(path.dirname(legacyPaths.dbPath), { recursive: true });
      createProjectDb(legacyPaths.dbPath, "DP Code project");

      const result = yield* migrateLegacyHomeIfNeeded({
        baseDir: targetBaseDir,
        homeDir: tempHome,
        devUrl: undefined,
      });

      assert.deepStrictEqual(result, {
        status: "migrated",
        reason: "migrated",
        importedArtifacts: ["database"],
      });
      assert.equal(readProjectTitle(targetPaths.dbPath), "DP Code project");
      assert.isTrue(fs.existsSync(legacyPaths.dbPath));
    }),
  );

  it.effect("fills missing dpcode artifacts from older t3 state", () =>
    Effect.gen(function* () {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "synara-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const dpcodeBaseDir = path.join(tempHome, LEGACY_DPCODE_HOME_DIRNAME);
      const t3BaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, SYNARA_HOME_DIRNAME);
      const dpcodePaths = yield* deriveServerPaths(dpcodeBaseDir, undefined);
      const t3Paths = yield* deriveServerPaths(t3BaseDir, undefined);
      const targetPaths = yield* deriveServerPaths(targetBaseDir, undefined);

      fs.mkdirSync(path.dirname(dpcodePaths.anonymousIdPath), { recursive: true });
      fs.writeFileSync(dpcodePaths.anonymousIdPath, "dpcode-anon-id");
      fs.mkdirSync(path.dirname(t3Paths.keybindingsConfigPath), { recursive: true });
      fs.writeFileSync(
        t3Paths.keybindingsConfigPath,
        '[{"key":"mod+k","command":"sidebar.search"}]\n',
      );
      createProjectDb(t3Paths.dbPath, "T3 project");

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
      assert.equal(readProjectTitle(targetPaths.dbPath), "T3 project");
      assert.equal(fs.readFileSync(targetPaths.anonymousIdPath, "utf8"), "dpcode-anon-id");
      assert.equal(
        fs.readFileSync(targetPaths.keybindingsConfigPath, "utf8").trim(),
        '[{"key":"mod+k","command":"sidebar.search"}]',
      );
    }),
  );

  it.effect("imports legacy userdata into the new default home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "synara-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, SYNARA_HOME_DIRNAME);
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

  it.effect("preserves settings, credentials, and environment identity", () =>
    Effect.gen(function* () {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "synara-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, SYNARA_HOME_DIRNAME);
      const legacyPaths = yield* deriveServerPaths(legacyBaseDir, undefined);
      const targetPaths = yield* deriveServerPaths(targetBaseDir, undefined);

      fs.mkdirSync(legacyPaths.secretsDir, { recursive: true });
      fs.writeFileSync(legacyPaths.settingsPath, '{"voiceTranscription":{"provider":"local"}}\n');
      fs.writeFileSync(path.join(legacyPaths.secretsDir, "session-signing.bin"), "secret-bytes");
      fs.writeFileSync(legacyPaths.anonymousIdPath, "existing-anonymous-id");
      fs.writeFileSync(legacyPaths.environmentIdPath, "existing-environment-id\n");

      const result = yield* migrateLegacyHomeIfNeeded({
        baseDir: targetBaseDir,
        homeDir: tempHome,
        devUrl: undefined,
      });

      assert.deepStrictEqual(result, {
        status: "migrated",
        reason: "migrated",
        importedArtifacts: ["settings", "secrets", "anonymousId", "environmentId"],
      });
      assert.equal(
        fs.readFileSync(targetPaths.settingsPath, "utf8"),
        '{"voiceTranscription":{"provider":"local"}}\n',
      );
      assert.equal(
        fs.readFileSync(path.join(targetPaths.secretsDir, "session-signing.bin"), "utf8"),
        "secret-bytes",
      );
      assert.equal(fs.readFileSync(targetPaths.anonymousIdPath, "utf8"), "existing-anonymous-id");
      assert.equal(
        fs.readFileSync(targetPaths.environmentIdPath, "utf8"),
        "existing-environment-id\n",
      );
    }),
  );

  it.effect("repairs artifacts omitted by an older completed import", () =>
    Effect.gen(function* () {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "synara-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, SYNARA_HOME_DIRNAME);
      const legacyPaths = yield* deriveServerPaths(legacyBaseDir, undefined);
      const targetPaths = yield* deriveServerPaths(targetBaseDir, undefined);
      const markerPath = yield* getLegacyImportMarkerPath(targetPaths.stateDir);

      fs.mkdirSync(legacyPaths.attachmentsDir, { recursive: true });
      fs.mkdirSync(legacyPaths.secretsDir, { recursive: true });
      createProjectDb(legacyPaths.dbPath, "Legacy project");
      fs.writeFileSync(legacyPaths.settingsPath, '{"upgradeProbe":"legacy-settings"}\n');
      fs.writeFileSync(legacyPaths.keybindingsConfigPath, "[]\n");
      fs.writeFileSync(path.join(legacyPaths.attachmentsDir, "existing.txt"), "legacy");
      fs.writeFileSync(path.join(legacyPaths.attachmentsDir, "missing.txt"), "recover me");
      fs.writeFileSync(path.join(legacyPaths.secretsDir, "server-signing-key.bin"), "legacy-key");
      fs.writeFileSync(path.join(legacyPaths.secretsDir, "provider-token.bin"), "recover me");
      fs.writeFileSync(legacyPaths.anonymousIdPath, "legacy-anonymous-id");
      fs.writeFileSync(legacyPaths.environmentIdPath, "legacy-environment-id\n");

      fs.mkdirSync(targetPaths.attachmentsDir, { recursive: true });
      fs.mkdirSync(targetPaths.secretsDir, { recursive: true });
      createProjectDb(targetPaths.dbPath, "Already imported project");
      fs.writeFileSync(targetPaths.keybindingsConfigPath, "[]\n");
      fs.writeFileSync(path.join(targetPaths.attachmentsDir, "existing.txt"), "newer");
      fs.writeFileSync(path.join(targetPaths.secretsDir, "server-signing-key.bin"), "newer-key");
      fs.writeFileSync(targetPaths.anonymousIdPath, "already-imported-anonymous-id");
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify(
          {
            status: "completed",
            sourceBaseDir: legacyBaseDir,
            targetBaseDir,
            sourceStateDir: legacyPaths.stateDir,
            targetStateDir: targetPaths.stateDir,
            importedArtifacts: ["database", "keybindings", "attachments", "anonymousId"],
            startedAt: new Date().toISOString(),
            migratedAt: new Date().toISOString(),
            notes: ["older importer stopped too early"],
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
        importedArtifacts: [
          "database",
          "settings",
          "keybindings",
          "attachments",
          "secrets",
          "anonymousId",
          "environmentId",
        ],
      });
      assert.equal(readProjectTitle(targetPaths.dbPath), "Already imported project");
      assert.equal(
        fs.readFileSync(targetPaths.settingsPath, "utf8"),
        '{"upgradeProbe":"legacy-settings"}\n',
      );
      assert.equal(
        fs.readFileSync(path.join(targetPaths.attachmentsDir, "existing.txt"), "utf8"),
        "newer",
      );
      assert.equal(
        fs.readFileSync(path.join(targetPaths.attachmentsDir, "missing.txt"), "utf8"),
        "recover me",
      );
      assert.equal(
        fs.readFileSync(path.join(targetPaths.secretsDir, "server-signing-key.bin"), "utf8"),
        "newer-key",
      );
      assert.equal(
        fs.readFileSync(path.join(targetPaths.secretsDir, "provider-token.bin"), "utf8"),
        "recover me",
      );
      assert.equal(
        fs.readFileSync(targetPaths.anonymousIdPath, "utf8"),
        "already-imported-anonymous-id",
      );
      assert.equal(
        fs.readFileSync(targetPaths.environmentIdPath, "utf8"),
        "legacy-environment-id\n",
      );
      assert.deepStrictEqual(readMarker(markerPath).importedArtifacts, [
        "database",
        "settings",
        "keybindings",
        "attachments",
        "secrets",
        "anonymousId",
        "environmentId",
      ]);
    }),
  );

  it.effect("does not let generated identity files block meaningful state import", () =>
    Effect.gen(function* () {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "synara-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, SYNARA_HOME_DIRNAME);
      const legacyPaths = yield* deriveServerPaths(legacyBaseDir, undefined);
      const targetPaths = yield* deriveServerPaths(targetBaseDir, undefined);

      fs.mkdirSync(path.dirname(legacyPaths.dbPath), { recursive: true });
      createProjectDb(legacyPaths.dbPath, "Legacy project");
      fs.mkdirSync(targetPaths.secretsDir, { recursive: true });
      fs.writeFileSync(path.join(targetPaths.secretsDir, "session-signing.bin"), "newer-secret");
      fs.writeFileSync(targetPaths.anonymousIdPath, "newer-anonymous-id");
      fs.writeFileSync(targetPaths.environmentIdPath, "newer-environment-id\n");

      const result = yield* migrateLegacyHomeIfNeeded({
        baseDir: targetBaseDir,
        homeDir: tempHome,
        devUrl: undefined,
      });

      assert.equal(result.status, "migrated");
      assert.equal(readProjectTitle(targetPaths.dbPath), "Legacy project");
      assert.equal(
        fs.readFileSync(path.join(targetPaths.secretsDir, "session-signing.bin"), "utf8"),
        "newer-secret",
      );
      assert.equal(fs.readFileSync(targetPaths.anonymousIdPath, "utf8"), "newer-anonymous-id");
      assert.equal(
        fs.readFileSync(targetPaths.environmentIdPath, "utf8"),
        "newer-environment-id\n",
      );
    }),
  );

  it.effect("preserves target logs while importing legacy state", () =>
    Effect.gen(function* () {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "synara-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, SYNARA_HOME_DIRNAME);
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
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "synara-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, SYNARA_HOME_DIRNAME);
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
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "synara-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, SYNARA_HOME_DIRNAME);
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
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "synara-home-migration-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(tempHome, { recursive: true, force: true })),
      );

      const legacyBaseDir = path.join(tempHome, LEGACY_T3_HOME_DIRNAME);
      const targetBaseDir = path.join(tempHome, SYNARA_HOME_DIRNAME);
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
