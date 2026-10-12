// Shared by packaging, artifact provenance and native startup verification.
export type LinuxPackageTarget = "AppImage" | "deb" | "rpm";

export function parseLinuxPackageTargets(target: string): ReadonlyArray<LinuxPackageTarget> {
  const entries = target.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error("Linux package targets must not contain empty entries.");
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error("Linux package targets must be unique.");
  }
  return entries.map((entry) => {
    if (entry !== "AppImage" && entry !== "deb" && entry !== "rpm") {
      throw new Error(`Unsupported Linux package target: ${entry}.`);
    }
    return entry;
  });
}
