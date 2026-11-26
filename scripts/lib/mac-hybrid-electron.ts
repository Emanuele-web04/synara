import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "./file-digest.ts";

export const hybridPatch = fileURLToPath(
  new URL("../../apps/desktop/patches/electron-hybrid/native-hybrid.patch", import.meta.url),
);
export const hybridLicense = fileURLToPath(
  new URL("../../apps/desktop/patches/electron-hybrid/LICENSE-Nightly-Labs", import.meta.url),
);
const pinFile = new URL(
  "../../apps/desktop/patches/electron-hybrid/upstream.json",
  import.meta.url,
);
const packageFile = new URL("../../apps/desktop/package.json", import.meta.url);
const framework =
  "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework";
const target = "electron:electron_dist_zip";

export function hybridSourceReference() {
  const pin = JSON.parse(readFileSync(pinFile, "utf8"));
  const projectVersion = JSON.parse(readFileSync(packageFile, "utf8")).dependencies.electron;
  const patchSha256 = createHash("sha256").update(readFileSync(hybridPatch)).digest("hex");
  if (
    pin.electronVersion !== projectVersion ||
    !/^[0-9a-f]{40}$/.test(pin.electronCommit) ||
    !/^[0-9a-f]{40}$/.test(pin.chromiumCommit) ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(pin.chromiumVersion) ||
    pin.patchSha256 !== patchSha256
  ) {
    throw new Error(
      "The native hybrid patch, upstream revision or desktop Electron pin does not match upstream.json.",
    );
  }
  return {
    electronVersion: String(pin.electronVersion),
    electronCommit: String(pin.electronCommit),
    chromiumVersion: String(pin.chromiumVersion),
    chromiumCommit: String(pin.chromiumCommit),
    patchSha256,
  };
}

export function hybridArchiveMetadata(arch: string) {
  if (arch !== "arm64" && arch !== "x64")
    throw new Error("A macOS hybrid Electron archive requires arm64 or x64.");
  const source = hybridSourceReference();
  return {
    schemaVersion: 1,
    ...source,
    platform: "darwin",
    arch,
    target,
    archive: `electron-v${source.electronVersion}-darwin-${arch}.zip`,
  };
}

// Stream the actual Mach-O. A stock Electron zip with a relabeled manifest must fail.
async function verifyFramework(path: string, arch: string): Promise<void> {
  const markers = ["setWebAuthnHybridEnabled", "webauthn-hybrid-qr", "webauthn-hybrid-status"];
  const overlap = Math.max(...markers.map((marker) => marker.length)) - 1;
  const reader = spawn("/usr/bin/unzip", ["-p", path, framework], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const completed = once(reader, "close");
  let header = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  const missing = new Set(markers);
  const scan = async () => {
    for await (const chunk of reader.stdout) {
      const bytes = chunk as Buffer;
      if (header.length < 8) header = Buffer.concat([header, bytes.subarray(0, 8 - header.length)]);
      if (!missing.size) continue;
      const joined = Buffer.concat([tail, bytes]);
      for (const marker of missing) if (joined.includes(marker)) missing.delete(marker);
      tail = Buffer.from(joined.subarray(-overlap));
    }
  };
  const [[code]] = await Promise.all([completed, scan()]);
  if (
    code !== 0 ||
    header.length !== 8 ||
    header.readUInt32LE() !== 0xfeedfacf ||
    header.readUInt32LE(4) !== (arch === "arm64" ? 0x0100000c : 0x01000007)
  ) {
    throw new Error(`Electron Framework is not a macOS ${arch} Mach-O.`);
  }
  if (missing.size)
    throw new Error("Electron Framework lacks the native hybrid session API or events.");
}

/** Validates a local build artifact. Device authentication is qualified separately. */
export async function verifyMacHybridElectron(
  directory: string,
  arch: string,
  electronVersion: string,
): Promise<string> {
  const expected = hybridArchiveMetadata(arch);
  if (expected.electronVersion !== electronVersion)
    throw new Error("Electron version differs from the desktop pin.");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value)
      throw new Error(`Incorrect macOS hybrid runtime manifest field: ${key}.`);
  }
  const archive = resolve(directory, expected.archive);
  if (!readFileSync(join(directory, "LICENSE-Nightly-Labs")).equals(readFileSync(hybridLicense))) {
    throw new Error("Incorrect macOS hybrid runtime license.");
  }
  if (
    !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) ||
    (await hashFile(archive)) !== manifest.archiveSha256
  ) {
    throw new Error("Incorrect macOS hybrid Electron archive digest.");
  }
  const info = execFileSync("/usr/bin/unzip", ["-p", archive, "Electron.app/Contents/Info.plist"]);
  const version = execFileSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", "-"],
    { input: info, encoding: "utf8" },
  ).trim();
  if (version !== electronVersion)
    throw new Error("Electron.app version does not match the requested runtime.");
  await verifyFramework(archive, arch);
  const zipLicense = execFileSync("/usr/bin/unzip", ["-p", archive, "LICENSE-Nightly-Labs"]);
  if (!zipLicense.equals(readFileSync(hybridLicense)))
    throw new Error("The native runtime ZIP is missing its license.");
  return archive;
}
