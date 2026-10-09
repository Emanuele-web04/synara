// One declaration is shared by packaging, provenance and packaged startup smoke.
export type LinuxPackageTarget = "AppImage" | "deb";

export function parseLinuxPackageTargets(target: string): ReadonlyArray<LinuxPackageTarget> {
  const entries = target.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error("Linux package targets must not contain empty entries.");
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error("Linux package targets must be unique.");
  }
  return entries.map((entry) => {
    if (entry !== "AppImage" && entry !== "deb") {
      throw new Error(`Unsupported Linux package target: ${entry} (expected AppImage or deb).`);
    }
    return entry;
  });
}
