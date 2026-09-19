import { describe, expect, it } from "vitest";

import { asarUnpackedPath } from "./asarUnpackedPath.ts";

describe("asarUnpackedPath", () => {
  it("redirects a path inside app.asar to its unpacked twin", () => {
    expect(
      asarUnpackedPath("/opt/Synara/resources/app.asar/apps/server/dist/atspi_helper.py"),
    ).toBe("/opt/Synara/resources/app.asar.unpacked/apps/server/dist/atspi_helper.py");
  });

  it("rewrites only the archive segment, once", () => {
    expect(asarUnpackedPath("/tmp/app.asar/apps/server/dist/computer-use-kwin/app.asar/x")).toBe(
      "/tmp/app.asar.unpacked/apps/server/dist/computer-use-kwin/app.asar/x",
    );
  });

  it("leaves a path that is already unpacked alone", () => {
    const unpacked = "/opt/Synara/resources/app.asar.unpacked/apps/server/dist/atspi_helper.py";
    expect(asarUnpackedPath(unpacked)).toBe(unpacked);
  });

  it("leaves a checkout or other non-archive path alone", () => {
    for (const path of [
      "/home/dev/synara/apps/server/src/computer/atspi_helper.py",
      "/opt/app.asar",
      "/opt/my-app.asar/file",
      "/opt/app.asar-backup/file",
      "",
    ]) {
      expect(asarUnpackedPath(path)).toBe(path);
    }
  });

  it("handles Windows separators", () => {
    expect(asarUnpackedPath("C:\\Synara\\resources\\app.asar\\apps\\server\\dist\\x.py")).toBe(
      "C:\\Synara\\resources\\app.asar.unpacked\\apps\\server\\dist\\x.py",
    );
  });
});
