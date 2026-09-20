// FILE: betaImport.test.ts
// Purpose: Coverage for the beta-side stable-data snapshot import.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
} from "@synara/shared/betaChannel";
import { runBetaImportIfRequested } from "./betaImport";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-beta-import-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

async function seedStableHome(root: string): Promise<string> {
  const stableHome = join(root, ".synara");
  const stableState = join(stableHome, "userdata");
  mkdirSync(join(stableState, "secrets"), { recursive: true });
  mkdirSync(join(stableState, "logs"), { recursive: true });
  writeFileSync(join(stableState, "settings.json"), JSON.stringify({ theme: "dark" }));
  writeFileSync(join(stableState, "secrets", "token.json"), JSON.stringify({ token: "x" }));
  writeFileSync(join(stableState, "logs", "server.log"), "log line\n");
  writeFileSync(join(stableState, "server-runtime.json"), JSON.stringify({ pid: 1234 }));

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(stableState, "state.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
  db.exec("INSERT INTO threads VALUES ('t1', 'hello stable')");
  db.close();
  return stableHome;
}

function writeMarker(betaHome: string, sourceHomeDir: string): void {
  mkdirSync(betaHome, { recursive: true });
  writeFileSync(
    join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME),
    JSON.stringify({ version: 1, requestedAt: new Date().toISOString(), sourceHomeDir }),
  );
}

describe("runBetaImportIfRequested", () => {
  it("does nothing without a marker", async () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    const outcome = await runBetaImportIfRequested({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(false);
    expect(existsSync(join(betaHome, "userdata"))).toBe(false);
  });

  it("imports the stable snapshot and reports success", async () => {
    const root = await seedStableHome(makeRoot());
    const betaHome = join(root, ".synara-beta");
    const betaState = join(betaHome, "userdata");
    writeMarker(betaHome, root);

    const outcome = await runBetaImportIfRequested({ betaHomeDir: betaHome, stateDir: betaState });
    expect(outcome).toEqual({ consumed: true, ok: true });
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);

    // Marker consumed, result written for the stable UI to read back.
    const result = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_RESULT_FILE_NAME), "utf8"));
    expect(result.ok).toBe(true);

    // Database snapshot is a real, queryable copy.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(betaState, "state.sqlite"), { readOnly: true });
    const rows = db.prepare("SELECT title FROM threads").all() as Array<{ title: string }>;
    db.close();
    expect(rows[0]?.title).toBe("hello stable");

    // Small state copied; runtime files excluded.
    expect(readFileSync(join(betaState, "settings.json"), "utf8")).toContain("dark");
    expect(existsSync(join(betaState, "secrets", "token.json"))).toBe(true);
    expect(existsSync(join(betaState, "logs"))).toBe(false);
    expect(existsSync(join(betaState, "server-runtime.json"))).toBe(false);
  });

  it("refuses an import that points at the beta home itself", async () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    writeMarker(betaHome, betaHome);

    const outcome = await runBetaImportIfRequested({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    const result = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_RESULT_FILE_NAME), "utf8"));
    expect(result.error).toContain("beta home");
  });

  it("reports a missing stable database without crashing startup", async () => {
    const root = makeRoot();
    const stableHome = join(root, ".synara");
    mkdirSync(join(stableHome, "userdata"), { recursive: true });
    const betaHome = join(root, ".synara-beta");
    writeMarker(betaHome, stableHome);

    const outcome = await runBetaImportIfRequested({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("stable database not found");
  });

  it("replaces a stale marker without retry loops", async () => {
    const root = await seedStableHome(makeRoot());
    const betaHome = join(root, ".synara-beta");
    writeMarker(betaHome, root);
    writeFileSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME), "garbage");

    const outcome = await runBetaImportIfRequested({
      betaHomeDir: betaHome,
      stateDir: join(betaHome, "userdata"),
    });
    expect(outcome.consumed).toBe(true);
    expect(outcome.ok).toBe(false);
    // Marker is gone — a second boot does not retry a malformed request.
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);
  });
});
