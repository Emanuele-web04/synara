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
  const buildIdPath = "usr/lib/.build-id/16/6a10e13400be630d45cdc040664c53511639a6";
  const buildId = (target: string) => entry(buildIdPath, 0o120777, 1, Buffer.from(target));

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
  it("accepts rpmbuild metadata links to regular application files even when listed first", () => {
    expect(() =>
      assertRpmCpioArchive(
        archive(buildId("../../../../opt/Synara/synara"), entry("./opt/Synara/synara")),
      ),
    ).not.toThrow();
  });
  it.each([
    "/opt/Synara/synara",
    "../../../../../opt/Synara/synara",
    "../../../../opt//Synara/synara",
    "../../../../opt\\Synara\\synara",
    "../../../../opt/Synara/synara\0hidden",
    "../../../../opt/Synara/line\nbreak",
    "../../../../opt/Synara/missing",
    "",
  ])("rejects unsafe or missing build-id target %j", (target) => {
    expect(() =>
      assertRpmCpioArchive(archive(buildId(target), entry("opt/Synara/synara"))),
    ).toThrow();
  });
  it("rejects build-id links to directories, other links or files outside the app payload", () => {
    expect(() =>
      assertRpmCpioArchive(
        archive(
          buildId("../../../../opt/Synara"),
          entry("opt/Synara", 0o040755, 2, Buffer.alloc(0)),
        ),
      ),
    ).toThrow("archived application file");
    const other = "usr/lib/.build-id/23/60d2c52c9d8dea9ec199603c0214e74669cde0";
    expect(() =>
      assertRpmCpioArchive(
        archive(
          buildId("../23/60d2c52c9d8dea9ec199603c0214e74669cde0"),
          entry(other, 0o120777, 1, Buffer.from("../../../../opt/Synara/synara")),
          entry("opt/Synara/synara"),
        ),
      ),
    ).toThrow("archived application file");
    expect(() =>
      assertRpmCpioArchive(archive(buildId("../../../../etc/config"), entry("etc/config"))),
    ).toThrow("archived application file");
  });
  it("rejects extraction paths through a link or regular-file ancestor", () => {
    expect(() =>
      assertRpmCpioArchive(
        archive(
          buildId("../../../../opt/Synara/synara"),
          entry(`${buildIdPath}/nested`),
          entry("opt/Synara/synara"),
        ),
      ),
    ).toThrow("non-directory");
    expect(() =>
      assertRpmCpioArchive(archive(entry("opt/Synara"), entry("opt/Synara/synara"))),
    ).toThrow("non-directory");
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
