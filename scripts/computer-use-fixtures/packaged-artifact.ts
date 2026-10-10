/** Verify the exact explicitly selected isolated macOS package and driver. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { SYNARA_CUA_BUNDLE_ID } from "@synara/shared/desktopIdentity";
import { spawnProcessSync } from "@synara/shared/processRuntime";
import release from "../../packages/shared/src/cuaDriverRelease.json";

const APPLICATION_LOOKUP_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  var url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(argv[0]);
  return JSON.stringify(ObjC.unwrap(url.path) || null);
}
`;

export class PackagedAppInstallationError extends Error {
  constructor(reason: "temporary-path" | "unregistered" | "different-copy" | "lookup-failed") {
    const descriptions = {
      "temporary-path": "The selected Cua app is in temporary storage.",
      unregistered: "macOS cannot resolve the selected Cua app through LaunchServices.",
      "different-copy": "macOS resolves the Cua bundle ID to a different installed copy.",
      "lookup-failed": "The read-only macOS application registration check could not complete.",
    };
    super(
      `${descriptions[reason]} Copy the same packaged bundle to ~/Applications/Synara Cua.app without overwriting an existing app, register that installed copy, and quit the temporary instance. Rerun --prepare-only with --bundle "$HOME/Applications/Synara Cua.app" and a new isolated --home, then grant permissions to that copy. See scripts/computer-use-fixtures/packaged-e2e.md.`,
    );
    this.name = "PackagedAppInstallationError";
  }
}

/** Both paths must be canonical: another copy's registration cannot prove this app's identity. */
export function assertPackagedAppInstallation(bundle: string, registeredBundle: string | null) {
  const temporaryRoots = ["/private/tmp", "/tmp", "/private/var/folders", "/var/folders"];
  if (temporaryRoots.some((root) => bundle === root || bundle.startsWith(`${root}/`)))
    throw new PackagedAppInstallationError("temporary-path");
  if (registeredBundle === null) throw new PackagedAppInstallationError("unregistered");
  if (bundle !== registeredBundle) throw new PackagedAppInstallationError("different-copy");
}

async function registeredApplicationPath(bundleId: string): Promise<string | null> {
  try {
    const lookup = spawnProcessSync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", APPLICATION_LOOKUP_SCRIPT, bundleId],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 },
    );
    if (lookup.error || lookup.status !== 0) throw new Error("Application lookup failed.");
    const value: unknown = JSON.parse(lookup.stdout);
    if (value === null) return null;
    if (typeof value !== "string" || !isAbsolute(value))
      throw new Error("Application lookup returned an invalid path.");
    return await realpath(value);
  } catch {
    throw new PackagedAppInstallationError("lookup-failed");
  }
}

export async function artifactIdentity(bundle: string) {
  const plist = join(bundle, "Contents/Info.plist");
  const bundleId = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", plist],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (bundleId !== SYNARA_CUA_BUNDLE_ID)
    throw new Error("The runner requires an explicitly isolated Synara Cua application bundle.");
  // Registration exit status alone does not prove TCC can find the application.
  // This read-only check happens before either runner launches or creates a home.
  const registeredBundle = await registeredApplicationPath(bundleId);
  assertPackagedAppInstallation(bundle, registeredBundle);
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
    registeredBundle,
    nativeRevision: provenance.nativeRevision,
    nativeVersion: provenance.version,
    source: provenance.source,
    patchSha256: provenance.patchSha256,
    driverSha256: hash.digest("hex"),
  };
}
