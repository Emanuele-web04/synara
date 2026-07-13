import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acknowledgeSynaraStorageSnapshot,
  readSynaraStorageSnapshot,
  saveSynaraStorageSnapshot,
  SYNARA_STORAGE_SNAPSHOT_MAX_BYTES,
  validateSynaraStorageSnapshot,
} from "./desktopStorageMigration";

const snapshot = (exportedAt = "2026-07-09T00:00:00.000Z") => ({
  version: 1 as const,
  exportedAt,
  entries: {
    "synara:theme": "dark",
    "synara.openUsage.enabled": "true",
  },
});

describe("desktopStorageMigration", () => {
  it("round-trips atomically and acknowledges the snapshot", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      await expect(saveSynaraStorageSnapshot(target, snapshot())).resolves.toBe(true);
      expect(readSynaraStorageSnapshot(target)).toEqual(snapshot());
      expect(FS.readdirSync(directory)).toEqual(["snapshot.json"]);

      await acknowledgeSynaraStorageSnapshot(target);
      expect(readSynaraStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, disallowed, and oversized snapshots", () => {
    expect(validateSynaraStorageSnapshot({ version: 1 })).toBeNull();
    expect(
      validateSynaraStorageSnapshot({
        ...snapshot(),
        entries: { "foreign:theme": "dark" },
      }),
    ).toBeNull();
    expect(
      validateSynaraStorageSnapshot({
        ...snapshot(),
        entries: { "synara:large": "x".repeat(SYNARA_STORAGE_SNAPSHOT_MAX_BYTES) },
      }),
    ).toBeNull();
  });

  it("accepts renderer snapshots containing large composer drafts", () => {
    const largeDraft = "x".repeat(2 * 1024 * 1024);

    expect(
      validateSynaraStorageSnapshot({
        ...snapshot(),
        entries: { "synara:composer-drafts:v1": largeDraft },
      })?.entries["synara:composer-drafts:v1"],
    ).toBe(largeDraft);
  });

  it("does not replace a newer snapshot with an older export", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      await saveSynaraStorageSnapshot(target, snapshot("2026-07-09T01:00:00.000Z"));
      await expect(
        saveSynaraStorageSnapshot(target, snapshot("2026-07-09T00:00:00.000Z")),
      ).resolves.toBe(false);
      expect(readSynaraStorageSnapshot(target)?.exportedAt).toBe("2026-07-09T01:00:00.000Z");
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats missing and malformed files as absent", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      expect(readSynaraStorageSnapshot(target)).toBeNull();
      FS.writeFileSync(target, "not json");
      expect(readSynaraStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
