import type { LinuxDistribution } from "./linuxDistribution.ts";

/** Known stock package sets that cannot build the Qt 6 / KF6 plugin. */
export function kwinDistributionSetupProblem(
  distribution: LinuxDistribution | undefined,
): string | undefined {
  if (!distribution) return undefined;
  const { id, versionId } = distribution;
  if (id !== "ubuntu" && id !== "debian") return undefined;
  const version =
    versionId && /^\d+(?:\.\d+)*$/.test(versionId) ? versionId.split(".").map(Number) : undefined;
  const name = id === "ubuntu" ? "Ubuntu" : "Debian";
  if (!version) {
    return `Synara could not determine this ${name} release. Automatic KWin setup requires a release with KWin 6, Qt 6 and KDE Frameworks 6.`;
  }
  const tooOld =
    id === "ubuntu"
      ? version[0]! < 24 || (version[0] === 24 && (version[1] ?? 0) < 10)
      : version[0]! < 13;
  if (!tooOld) return undefined;
  return (
    `${name} ${versionId} ships KWin 5. Synara's computer-use plugin requires KWin 6, Qt 6 and KDE Frameworks 6. ` +
    `Upgrade to ${id === "ubuntu" ? "Ubuntu 26.04 LTS" : "Debian 13"} or another distribution with that toolchain, then run Set up again.`
  );
}

export function kwinVersionSetupProblem(version: string | undefined): string | undefined {
  if (!version || !/^\d+\./.test(version) || Number(version.split(".")[0]) >= 6) return undefined;
  return `KWin ${version} is unsupported. Synara's computer-use plugin requires KWin 6, Qt 6 and KDE Frameworks 6. Upgrade the desktop and its development packages before running Set up.`;
}
