/** Verify the exact explicitly selected isolated macOS package and driver. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SYNARA_CUA_BUNDLE_ID } from "@synara/shared/desktopIdentity";
import release from "../../packages/shared/src/cuaDriverRelease.json";

export async function artifactIdentity(bundle: string) {
  const plist = join(bundle, "Contents/Info.plist");
  const bundleId = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", plist],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (bundleId !== SYNARA_CUA_BUNDLE_ID)
    throw new Error("The runner requires an explicitly isolated Synara Cua application bundle.");
  const driver = join(bundle, "Contents/Resources/cua-driver");
  const provenance = JSON.parse(await readFile(join(driver, "provenance.json"), "utf8"));
  if (
    provenance.nativeRevision !== release.nativeRevision ||
    provenance.version !== release.version ||
    provenance.source !== release.source ||
    provenance.patchSha256 !== release.patchSha256
  )
    throw new Error("Packaged native provenance does not match the checkout's pinned revision.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(driver, "cua-driver"))) hash.update(chunk);
  return {
    bundle,
    bundleId,
    nativeRevision: provenance.nativeRevision,
    nativeVersion: provenance.version,
    source: provenance.source,
    patchSha256: provenance.patchSha256,
    driverSha256: hash.digest("hex"),
  };
}
