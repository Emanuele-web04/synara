import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTerminalHistoryMetadata,
  deleteTerminalHistoryRecord,
  readTerminalHistoryRecord,
  terminalHistoryMetadataPath,
  writeDimensionlessTerminalHistory,
  writeTerminalHistoryRecord,
} from "./terminalHistoryRecord";

const directories: string[] = [];

function fixture(): {
  directory: string;
  historyPath: string;
  nextTempPath: (path: string) => string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-history-record-"));
  directories.push(directory);
  let counter = 0;
  return {
    directory,
    historyPath: path.join(directory, "terminal.log"),
    nextTempPath: (target) => `${target}.tmp-${++counter}`,
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe("terminalHistoryRecord", () => {
  it("round-trips exact UTF-8 bytes, dimensions, digest, and stable identity", async () => {
    const { historyPath, nextTempPath } = fixture();
    const history = "ASCII 中 e\u0301 👩‍💻\n\u001b[31mred\u001b[0m";
    const metadata = await writeTerminalHistoryRecord(historyPath, history, 91, 27, nextTempPath);
    expect(metadata.byteLength).toBe(Buffer.byteLength(history, "utf8"));
    expect(metadata.sha256).toBe(createTerminalHistoryMetadata(history, 91, 27).sha256);
    expect(await readTerminalHistoryRecord(historyPath, (value) => value)).toEqual({
      history,
      recoveredCols: 91,
      recoveredRows: 27,
      historyRecordIdentity: metadata.recordIdentity,
    });
  });

  it("changes identity for bytes or dimensions and preserves identity otherwise", () => {
    const first = createTerminalHistoryMetadata("same", 80, 24);
    expect(createTerminalHistoryMetadata("same", 80, 24).recordIdentity).toBe(first.recordIdentity);
    expect(createTerminalHistoryMetadata("changed", 80, 24).recordIdentity).not.toBe(
      first.recordIdentity,
    );
    expect(createTerminalHistoryMetadata("same", 81, 24).recordIdentity).not.toBe(
      first.recordIdentity,
    );
  });

  it.each([
    ["missing", null],
    ["truncated", '{"version":1'],
    [
      "unsupported",
      JSON.stringify({
        version: 2,
        cols: 80,
        rows: 24,
        byteLength: 4,
        sha256: "a".repeat(64),
        recordIdentity: "b".repeat(64),
      }),
    ],
    [
      "invalid dimensions",
      JSON.stringify({
        version: 1,
        cols: 2,
        rows: 24,
        byteLength: 4,
        sha256: "a".repeat(64),
        recordIdentity: "b".repeat(64),
      }),
    ],
    [
      "invalid digest",
      JSON.stringify({
        version: 1,
        cols: 80,
        rows: 24,
        byteLength: 4,
        sha256: "no",
        recordIdentity: "b".repeat(64),
      }),
    ],
    ["excessive", "x".repeat(4_097)],
  ])("falls back to legacy history for %s metadata", async (_name, sidecar) => {
    const { historyPath } = fixture();
    fs.writeFileSync(historyPath, "safe");
    if (sidecar !== null) fs.writeFileSync(terminalHistoryMetadataPath(historyPath), sidecar);
    expect(await readTerminalHistoryRecord(historyPath, (value) => value)).toEqual({
      history: "safe",
    });
  });

  it("treats new metadata with old changed history as dimensionless", async () => {
    const { historyPath } = fixture();
    const metadata = createTerminalHistoryMetadata("new", 100, 30);
    fs.writeFileSync(terminalHistoryMetadataPath(historyPath), JSON.stringify(metadata));
    fs.writeFileSync(historyPath, "old");
    expect(await readTerminalHistoryRecord(historyPath, (value) => value)).toEqual({
      history: "old",
    });
  });

  it("commits metadata before history and safely exposes an interrupted write", async () => {
    const { historyPath, nextTempPath } = fixture();
    fs.writeFileSync(historyPath, "old");
    const expectedMetadata = createTerminalHistoryMetadata("new", 100, 30);
    await expect(
      writeTerminalHistoryRecord(historyPath, "new", 100, 30, nextTempPath, () => {
        expect(
          JSON.parse(fs.readFileSync(terminalHistoryMetadataPath(historyPath), "utf8")),
        ).toEqual(expectedMetadata);
        expect(fs.readFileSync(historyPath, "utf8")).toBe("old");
        throw new Error("interrupted after metadata");
      }),
    ).rejects.toThrow("interrupted after metadata");
    expect(await readTerminalHistoryRecord(historyPath, (value) => value)).toEqual({
      history: "old",
    });
  });

  it("accepts new metadata with unchanged history for a dimensions-only commit", async () => {
    const { historyPath } = fixture();
    fs.writeFileSync(historyPath, "same");
    const metadata = createTerminalHistoryMetadata("same", 120, 40);
    fs.writeFileSync(terminalHistoryMetadataPath(historyPath), JSON.stringify(metadata));
    expect(await readTerminalHistoryRecord(historyPath, (value) => value)).toMatchObject({
      recoveredCols: 120,
      recoveredRows: 40,
    });
  });

  it("returns no record for old metadata with missing history", async () => {
    const { historyPath } = fixture();
    fs.writeFileSync(
      terminalHistoryMetadataPath(historyPath),
      JSON.stringify(createTerminalHistoryMetadata("gone", 80, 24)),
    );
    expect(await readTerminalHistoryRecord(historyPath, (value) => value)).toBeNull();
  });

  it("reports normalization without trusting metadata for different source bytes", async () => {
    const { historyPath } = fixture();
    fs.writeFileSync(historyPath, "unsafe");
    fs.writeFileSync(
      terminalHistoryMetadataPath(historyPath),
      JSON.stringify(createTerminalHistoryMetadata("safe", 80, 24)),
    );
    expect(await readTerminalHistoryRecord(historyPath, () => "safe")).toEqual({
      history: "safe",
      historyWasNormalized: true,
    });
  });

  it("rewrites a normalized legacy source metadata-first and keeps it dimensionless", async () => {
    const { historyPath, nextTempPath } = fixture();
    await writeTerminalHistoryRecord(historyPath, "unsafe", 80, 24, nextTempPath);
    await writeDimensionlessTerminalHistory(historyPath, "safe", nextTempPath);
    expect(fs.readFileSync(historyPath, "utf8")).toBe("safe");
    expect(fs.existsSync(terminalHistoryMetadataPath(historyPath))).toBe(false);
    expect(await readTerminalHistoryRecord(historyPath, (value) => value)).toEqual({
      history: "safe",
    });
  });

  it("survives native replacement and cleans private temporary files", async () => {
    const { directory, historyPath, nextTempPath } = fixture();
    await writeTerminalHistoryRecord(historyPath, "old", 80, 24, nextTempPath);
    await writeTerminalHistoryRecord(historyPath, "new", 100, 30, nextTempPath);
    expect(fs.readFileSync(historyPath, "utf8")).toBe("new");
    expect(fs.readdirSync(directory).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("leaves readable dimensionless history when deletion stops after metadata", async () => {
    const { historyPath, nextTempPath } = fixture();
    await writeTerminalHistoryRecord(historyPath, "keep", 80, 24, nextTempPath);
    await expect(
      deleteTerminalHistoryRecord(historyPath, () => {
        throw new Error("interrupted delete");
      }),
    ).rejects.toThrow("interrupted delete");
    expect(fs.existsSync(terminalHistoryMetadataPath(historyPath))).toBe(false);
    expect(await readTerminalHistoryRecord(historyPath, (value) => value)).toEqual({
      history: "keep",
    });
    await deleteTerminalHistoryRecord(historyPath);
    expect(fs.existsSync(historyPath)).toBe(false);
    expect(fs.existsSync(terminalHistoryMetadataPath(historyPath))).toBe(false);
  });
});
