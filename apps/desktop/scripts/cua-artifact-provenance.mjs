export const LINUX_CUA_INPUT_SCOPE = "owned-headless-browser";

// The CLI delegates cursor-theme authoring to the sibling executable. AT-SPI
// observations use Rust/zbus; the GNOME extension sources are also embedded in
// the driver, and these files preserve the upstream manual installation route.
export const LINUX_CUA_SIDECAR_PATHS = [
  "cua-cursor-theme",
  "wayland-helper/install.sh",
  "wayland-helper/README.md",
  "wayland-helper/winrects@cua/extension.js",
  "wayland-helper/winrects@cua/metadata.json",
];

export function assertLinuxCuaBuildHost({ platform, hostPlatform, arch, hostArch, artifact }) {
  if (platform !== "linux" || artifact) return;
  if (hostPlatform !== "linux" || hostArch !== arch) {
    throw new Error(
      `Patched Linux Cua requires a matching native linux/${arch} build host or a verified --artifact-dir.`,
    );
  }
}

export function assertLinuxCuaBinaryIdentity(bytes, architectures) {
  const machine = architectures[0] === "arm64" ? 183 : 62;
  if (
    architectures.length !== 1 ||
    bytes.length < 20 ||
    bytes[0] !== 0x7f ||
    bytes.toString("ascii", 1, 4) !== "ELF" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== machine
  ) {
    throw new Error("Cua Linux artifact is not an ELF executable for the requested architecture.");
  }
}

export function assertCuaArtifactProvenance({
  provenance,
  release,
  platform,
  architectures,
  binarySha256,
}) {
  const legacyMacPlatform = platform === "darwin" && provenance.platform === undefined;
  if (
    provenance.version !== release.version ||
    provenance.source !== release.source ||
    provenance.nativeRevision !== release.nativeRevision ||
    provenance.rustVersion !== release.rustVersion ||
    (!legacyMacPlatform && provenance.platform !== platform) ||
    !Array.isArray(provenance.architectures) ||
    architectures.some((value) => !provenance.architectures.includes(value)) ||
    binarySha256 !== provenance.binarySha256
  ) {
    throw new Error("Cua artifact identity, platform, architecture or binary checksum mismatch.");
  }
  if (provenance.patched === false) {
    if (
      platform === "darwin" ||
      provenance.patchSha256 != null ||
      provenance.linuxBrowserPatchSha256 != null ||
      (provenance.browserInputControl !== undefined && provenance.browserInputControl !== 0) ||
      provenance.inputScope != null
    ) {
      throw new Error("An unpatched Cua artifact cannot claim patched input capabilities.");
    }
    return;
  }
  if (platform === "win32" || provenance.patchSha256 !== release.patchSha256) {
    throw new Error("Cua artifact native patch checksum mismatch.");
  }
  if (
    platform === "linux" &&
    (provenance.patched !== true ||
      provenance.linuxBrowserPatchSha256 !== release.linuxBrowserPatchSha256 ||
      provenance.browserInputControl !== release.linuxBrowserInputControl ||
      provenance.browserInputControl !== 1 ||
      provenance.inputScope !== LINUX_CUA_INPUT_SCOPE ||
      typeof provenance.rustcVersion !== "string" ||
      !provenance.rustcVersion.startsWith(`rustc ${release.rustVersion} `))
  ) {
    throw new Error("Cua Linux browser patch, capability or compiler provenance mismatch.");
  }
  if (
    platform === "darwin" &&
    (provenance.linuxBrowserPatchSha256 != null || provenance.inputScope != null)
  ) {
    throw new Error("A macOS Cua artifact cannot carry Linux-only input provenance.");
  }
}

export function assertLinuxCuaSidecarChecksums(provenance, checksums) {
  if (
    !provenance.sidecarSha256 ||
    LINUX_CUA_SIDECAR_PATHS.some(
      (path) =>
        typeof provenance.sidecarSha256[path] !== "string" ||
        checksums[path] !== provenance.sidecarSha256[path],
    )
  ) {
    throw new Error("Cua Linux sidecar checksum mismatch or required sidecar missing.");
  }
}
