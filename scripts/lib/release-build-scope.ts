const platforms = [
  {
    id: "mac-arm64",
    label: "macOS arm64",
    runner: "macos-15",
    platform: "mac",
    target: "dmg",
    arch: "arm64",
  },
  {
    id: "mac-x64",
    label: "macOS x64",
    runner: "macos-15-intel",
    platform: "mac",
    target: "dmg",
    arch: "x64",
  },
  {
    id: "linux-x64",
    label: "Linux x64",
    runner: "ubuntu-24.04",
    platform: "linux",
    target: "AppImage",
    arch: "x64",
  },
  {
    id: "win-x64",
    label: "Windows x64",
    runner: "windows-2022",
    platform: "win",
    target: "nsis",
    arch: "x64",
  },
] as const;

export function resolveReleaseBuildScope(
  platform = "all",
  stage = "artifact",
  publish = false,
  cuaBenchmarkBaseline = "",
) {
  if (!["artifact", "native", "icon", "js", "preflight"].includes(stage))
    throw new Error(`Unknown build stage: ${stage}`);
  const selected = platforms.filter((entry) => platform === "all" || platform === entry.id);
  if (selected.length === 0) throw new Error(`Unknown build platform: ${platform}`);
  if (publish && (platform !== "all" || stage !== "artifact"))
    throw new Error("Publication requires all platforms and the complete artifact stage.");
  if (stage === "icon" && selected.every((entry) => entry.platform !== "mac"))
    throw new Error("Icon validation requires a macOS platform or all.");
  if (stage === "native" && platform === "win-x64")
    throw new Error("Windows does not compile the patched Cua driver.");
  if (
    cuaBenchmarkBaseline &&
    (publish ||
      stage !== "native" ||
      !["mac-arm64", "mac-x64"].includes(platform) ||
      !/^[a-f0-9]{40}$/.test(cuaBenchmarkBaseline))
  )
    throw new Error("Cua benchmark requires one native macOS platform and a full baseline commit.");
  return {
    matrix: {
      include: stage === "native" ? selected.filter((entry) => entry.platform !== "win") : selected,
    },
    build_icon:
      stage === "icon" ||
      (stage === "artifact" && selected.some((entry) => entry.platform === "mac")),
    build_js: stage === "js" || stage === "artifact",
    build_native: stage === "native" || stage === "artifact",
    benchmark_native: cuaBenchmarkBaseline !== "",
    // Lint, typecheck and the complete test suite. The preflight stage runs
    // only these gates, so quality-gate timing can be measured without native
    // builds, packaging or publication.
    quality_gates: stage === "artifact" || stage === "preflight",
    package_artifacts: stage === "artifact",
    build_server: stage === "artifact" && platform === "all",
  };
}
