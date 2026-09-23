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
    expect(scope).toMatchObject({
      build_icon: false,
      build_js: false,
      build_native: true,
      package_artifacts: false,
      build_server: false,
    });
  });
  it("runs the independent icon and JS stages without native packaging", () => {
    expect(resolveReleaseBuildScope("all", "icon")).toMatchObject({
      build_icon: true,
      build_native: false,
      build_js: false,
    });
    expect(resolveReleaseBuildScope("all", "js")).toMatchObject({
      build_icon: false,
      build_native: false,
      build_js: true,
    });
  });
  it("runs only the quality gates for the preflight stage", () => {
    expect(resolveReleaseBuildScope("all", "preflight")).toMatchObject({
      quality_gates: true,
      build_icon: false,
      build_js: false,
      build_native: false,
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
