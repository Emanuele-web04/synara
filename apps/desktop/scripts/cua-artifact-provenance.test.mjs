import { describe, expect, it } from "vitest";

import {
  assertCuaArtifactProvenance,
  assertLinuxCuaBinaryIdentity,
  assertLinuxCuaBuildHost,
  assertLinuxCuaSidecarChecksums,
  LINUX_CUA_INPUT_SCOPE,
  LINUX_CUA_SIDECAR_PATHS,
} from "./cua-artifact-provenance.mjs";

const release = {
  version: "0.28.2",
  source: "source-commit",
  nativeRevision: 32,
  patchSha256: "mac-base-checksum",
  linuxBrowserPatchSha256: "linux-delta-checksum",
  linuxBrowserInputControl: 1,
  rustVersion: "1.97.1",
};

function provenance(overrides = {}) {
  return {
    version: release.version,
    source: release.source,
    nativeRevision: release.nativeRevision,
    patchSha256: release.patchSha256,
    rustVersion: release.rustVersion,
    rustcVersion: "rustc 1.97.1 (pinned-compiler)",
    binarySha256: "binary-checksum",
    architectures: ["arm64"],
    ...overrides,
  };
}

function linuxProvenance(overrides = {}) {
  return provenance({
    platform: "linux",
    patched: true,
    linuxBrowserPatchSha256: release.linuxBrowserPatchSha256,
    browserInputControl: 1,
    inputScope: LINUX_CUA_INPUT_SCOPE,
    ...overrides,
  });
}

function validate(value, platform = "linux") {
  return assertCuaArtifactProvenance({
    provenance: value,
    release,
    platform,
    architectures: ["arm64"],
    binarySha256: "binary-checksum",
  });
}

describe("Cua platform and build provenance", () => {
  it("retains legacy signed Mac artifact reuse without requiring the Linux delta", () => {
    expect(() => validate(provenance({ signedIdentity: "Developer ID" }), "darwin")).not.toThrow();
    expect(() => validate(provenance({ platform: "darwin" }), "darwin")).not.toThrow();
  });

  it("accepts Linux browser-only control with both pinned patches and compiler", () => {
    expect(() => validate(linuxProvenance())).not.toThrow();
  });

  it.each([
    { platform: "darwin" },
    { platform: undefined },
    { architectures: ["x64"] },
    { binarySha256: "changed" },
    { source: "different-source" },
    { nativeRevision: 31 },
    { rustVersion: "nightly" },
    { rustcVersion: "rustc 1.96.0 (wrong)" },
    { patchSha256: "different-base" },
    { linuxBrowserPatchSha256: undefined },
    { linuxBrowserPatchSha256: "different-delta" },
    { browserInputControl: undefined },
    { browserInputControl: 0 },
    { inputScope: "native-desktop" },
  ])("rejects incompatible reusable Linux artifact %j", (override) => {
    expect(() => validate(linuxProvenance(override))).toThrow();
  });

  it("keeps unpatched Windows and old Linux artifacts explicit without input claims", () => {
    for (const platform of ["win32", "linux"]) {
      const unpatched = provenance({ platform, patched: false, patchSha256: null });
      expect(() => validate(unpatched, platform)).not.toThrow();
      expect(() => validate({ ...unpatched, browserInputControl: 1 }, platform)).toThrow(
        "unpatched",
      );
      expect(() =>
        validate(
          { ...unpatched, linuxBrowserPatchSha256: release.linuxBrowserPatchSha256 },
          platform,
        ),
      ).toThrow("unpatched");
    }
  });

  it("rejects cross-platform provenance even when the binary digest matches", () => {
    expect(() => validate(linuxProvenance(), "darwin")).toThrow("platform");
    expect(() => validate(provenance(), "linux")).toThrow("platform");
    expect(() => validate(provenance({ platform: "win32" }), "win32")).toThrow("patch");
  });

  it("only builds Linux on its native architecture but permits artifact verification elsewhere", () => {
    const request = { platform: "linux", arch: "arm64", hostPlatform: "linux", hostArch: "arm64" };
    expect(() => assertLinuxCuaBuildHost(request)).not.toThrow();
    expect(() => assertLinuxCuaBuildHost({ ...request, hostPlatform: "darwin" })).toThrow(
      "native linux/arm64",
    );
    expect(() => assertLinuxCuaBuildHost({ ...request, hostArch: "x64" })).toThrow();
    expect(() =>
      assertLinuxCuaBuildHost({ ...request, hostPlatform: "darwin", artifact: "/verified-later" }),
    ).not.toThrow();
  });

  it("verifies actual ELF architecture independently of provenance labels", () => {
    const elf = Buffer.alloc(20);
    elf.write("\x7fELF", 0, "ascii");
    elf[4] = 2;
    elf[5] = 1;
    elf.writeUInt16LE(183, 18);
    expect(() => assertLinuxCuaBinaryIdentity(elf, ["arm64"])).not.toThrow();
    expect(() => assertLinuxCuaBinaryIdentity(elf, ["x64"])).toThrow("ELF");
    expect(() => assertLinuxCuaBinaryIdentity(Buffer.from("MZ-windows"), ["arm64"])).toThrow("ELF");
    elf.writeUInt16LE(62, 18);
    expect(() => assertLinuxCuaBinaryIdentity(elf, ["x64"])).not.toThrow();
  });

  it("requires every staged Linux helper byte to match the recorded checksum", () => {
    const checksums = Object.fromEntries(
      LINUX_CUA_SIDECAR_PATHS.map((path) => [path, `sha:${path}`]),
    );
    const value = linuxProvenance({ sidecarSha256: checksums });
    expect(() => assertLinuxCuaSidecarChecksums(value, checksums)).not.toThrow();
    expect(() =>
      assertLinuxCuaSidecarChecksums(value, { ...checksums, "cua-cursor-theme": "changed" }),
    ).toThrow("sidecar");
    expect(() => assertLinuxCuaSidecarChecksums(value, {})).toThrow("sidecar");
    expect(() => assertLinuxCuaSidecarChecksums(linuxProvenance(), checksums)).toThrow("sidecar");
  });
});
