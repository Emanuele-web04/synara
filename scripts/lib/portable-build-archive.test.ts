import { describe, expect, it } from "vitest";
import { assertPortableArchiveEntries } from "./portable-build-archive.ts";
describe("portable archive extraction boundary", () => {
  it("allows only output roots and regular descendants", () => {
    expect(() =>
      assertPortableArchiveEntries(["apps/server/dist/", "apps/server/dist/index.mjs"], ["d", "-"]),
    ).not.toThrow();
  });
  it.each([
    "scripts/portable-build.ts",
    "/etc/passwd",
    "apps/server/dist/../../../package.json",
    "apps/server/dist-extra/file",
    "apps/server/dist/file\nname",
  ])("rejects %s before extraction", (path) => {
    expect(() => assertPortableArchiveEntries([path], ["-"])).toThrow("Unsafe");
  });
  it.each(["l", "h", "c", "p"])("rejects archive entry type %s", (type) => {
    expect(() => assertPortableArchiveEntries(["apps/server/dist/index.mjs"], [type])).toThrow(
      "regular files",
    );
  });
});
