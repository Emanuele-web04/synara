import { describe, expect, it } from "vitest";
import { resolveReleaseBuildScope } from "./release-build-scope.ts";
describe("release validation scope", () => {
  it("requires the complete four-platform artifact gate for publication", () => {
    expect(resolveReleaseBuildScope("all", "artifact", true).matrix.include).toHaveLength(4);
    for (const stage of ["native", "icon", "js"])
      expect(() => resolveReleaseBuildScope("all", stage, true)).toThrow("Publication requires");
    for (const platform of ["mac-arm64", "mac-x64", "linux-x64", "win-x64"])
      expect(() => resolveReleaseBuildScope(platform, "artifact", true)).toThrow(
        "Publication requires",
      );
  });
  it("qualifies Linux without an icon job or unrelated platforms", () => {
    const scope = resolveReleaseBuildScope("linux-x64", "native");
    expect(scope.matrix.include.map((entry) => entry.id)).toEqual(["linux-x64"]);
    expect(scope.cua_matrix.include.map((entry) => entry.id)).toEqual(["linux-x64"]);
    expect(scope).toMatchObject({
      build_icon: false,
      build_js: false,
      build_native: true,
      prepare_cua: true,
      package_artifacts: false,
      build_server: false,
    });
  });
  it("runs the independent icon and JS stages without native packaging", () => {
    expect(resolveReleaseBuildScope("all", "icon")).toMatchObject({
      build_icon: true,
      build_native: false,
      prepare_cua: false,
      build_js: false,
    });
    expect(resolveReleaseBuildScope("all", "js")).toMatchObject({
      build_icon: false,
      build_native: false,
      prepare_cua: false,
      build_js: true,
    });
  });
  it("runs only the quality gates for the preflight stage", () => {
    expect(resolveReleaseBuildScope("all", "preflight")).toMatchObject({
      quality_gates: true,
      build_icon: false,
      build_js: false,
      build_native: false,
      prepare_cua: false,
      package_artifacts: false,
      build_server: false,
    });
    expect(resolveReleaseBuildScope("all", "artifact")).toMatchObject({
      quality_gates: true,
      package_artifacts: true,
    });
    for (const stage of ["native", "icon", "js"])
      expect(resolveReleaseBuildScope("all", stage)).toMatchObject({ quality_gates: false });
    expect(() => resolveReleaseBuildScope("all", "preflight", true)).toThrow(
      "Publication requires",
    );
  });
  it("prepares native artifacts only for the selected Cua platforms", () => {
    const all = resolveReleaseBuildScope("all", "artifact");
    expect(all.prepare_cua).toBe(true);
    expect(all.cua_matrix.include.map((entry) => entry.id)).toEqual([
      "mac-arm64",
      "mac-x64",
      "linux-x64",
    ]);
    for (const platform of ["mac-arm64", "mac-x64", "linux-x64"]) {
      const scope = resolveReleaseBuildScope(platform, "artifact");
      expect(scope.prepare_cua).toBe(true);
      expect(scope.cua_matrix.include.map((entry) => entry.id)).toEqual([platform]);
    }
    const windows = resolveReleaseBuildScope("win-x64", "artifact");
    expect(windows.prepare_cua).toBe(false);
    expect(windows.cua_matrix.include).toEqual([]);
    expect(windows.package_artifacts).toBe(true);
  });
  it("rejects typos and unsupported Windows source compilation", () => {
    expect(() => resolveReleaseBuildScope("linux")).toThrow("Unknown build platform");
    expect(() => resolveReleaseBuildScope("all", "package")).toThrow("Unknown build stage");
    expect(() => resolveReleaseBuildScope("win-x64", "native")).toThrow("Windows");
  });
  it("restricts paired Cua benchmarks to one build-only native Mac", () => {
    const baseline = "a".repeat(40);
    expect(resolveReleaseBuildScope("mac-x64", "native", false, baseline)).toMatchObject({
      benchmark_native: true,
      package_artifacts: false,
      build_js: false,
      build_icon: false,
    });
    for (const platform of ["all", "linux-x64", "win-x64"])
      expect(() => resolveReleaseBuildScope(platform, "native", false, baseline)).toThrow();
    expect(() => resolveReleaseBuildScope("mac-x64", "artifact", false, baseline)).toThrow();
    expect(() => resolveReleaseBuildScope("all", "artifact", true, baseline)).toThrow();
    expect(() => resolveReleaseBuildScope("mac-x64", "native", false, "main")).toThrow();
  });
});
