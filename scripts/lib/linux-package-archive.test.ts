import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRpmCpioArchive } from "./linux-package-archive.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function entry(name: string, mode = 0o100755, links = 1, payload = Buffer.from("binary")): Buffer {
  const nameBytes = Buffer.from(name + "\0");
  const fields = [1, mode, 0, 0, links, 0, payload.length, 0, 0, 0, 0, nameBytes.length, 0];
  const header = Buffer.from(
    "070701" + fields.map((value) => value.toString(16).padStart(8, "0")).join(""),
  );
  const namePadding = Buffer.alloc((4 - ((110 + nameBytes.length) % 4)) % 4);
  const dataPadding = Buffer.alloc((4 - (payload.length % 4)) % 4);
  return Buffer.concat([header, nameBytes, namePadding, payload, dataPadding]);
}

function archive(...entries: Buffer[]): string {
  const root = mkdtempSync(join(tmpdir(), "synara-rpm-cpio-test-"));
  roots.push(root);
  const file = join(root, "payload.cpio");
  writeFileSync(file, Buffer.concat([...entries, entry("TRAILER!!!", 0, 1, Buffer.alloc(0))]));
  return file;
}

describe("RPM payload archive inspection", () => {
  it("accepts bounded newc files and directories before extraction", () => {
    expect(() =>
      assertRpmCpioArchive(
        archive(entry("./opt", 0o040755, 2, Buffer.alloc(0)), entry("./opt/Synara/synara")),
      ),
    ).not.toThrow();
  });
  it.each([
    "../outside",
    "/opt/Synara/synara",
    "opt//file",
    "opt/../file",
    "opt\\file",
    "line\nbreak",
    "file\0hidden",
  ])("rejects unsafe name %j", (name) => {
    expect(() => assertRpmCpioArchive(archive(entry(name)))).toThrow(/Unsafe RPM/);
  });
  it.each([0o120777, 0o020600, 0o060600, 0o010600])("rejects links and device type %i", (mode) => {
    expect(() => assertRpmCpioArchive(archive(entry("opt/file", mode)))).toThrow(
      "only files and directories",
    );
  });
  it("rejects hard links and duplicate paths", () => {
    expect(() => assertRpmCpioArchive(archive(entry("opt/file", 0o100644, 2)))).toThrow(
      "hard links",
    );
    expect(() => assertRpmCpioArchive(archive(entry("./opt/file"), entry("opt/file")))).toThrow(
      "Duplicate",
    );
  });
  it("rejects missing trailers, truncated payloads and trailing archive data", () => {
    const file = archive(entry("opt/file"));
    writeFileSync(file, entry("opt/file"));
    expect(() => assertRpmCpioArchive(file)).toThrow("missing its trailer");
    writeFileSync(file, entry("opt/file").subarray(0, -4));
    expect(() => assertRpmCpioArchive(file)).toThrow("Truncated");
    writeFileSync(
      file,
      Buffer.concat([
        entry("opt/file"),
        entry("TRAILER!!!", 0, 1, Buffer.alloc(0)),
        Buffer.from("extra"),
      ]),
    );
    expect(() => assertRpmCpioArchive(file)).toThrow("after RPM archive trailer");
  });
});
