import { describe, expect, it } from "vitest";

import {
  detectLinuxDistribution,
  linuxDistributionIdentity,
  parseLinuxDistribution,
  prebuiltBuiltOnForDistribution,
} from "./linuxDistribution.ts";

describe("os-release parsing", () => {
  it("does not infer another distro from /usr/lib when /etc is malformed", () => {
    const reads: string[] = [];
    expect(
      detectLinuxDistribution((path) => {
        reads.push(path);
        return path === "/etc/os-release" ? "NAME=Unknown\n" : "ID=arch\n";
      }),
    ).toBeUndefined();
    expect(reads).toEqual(["/etc/os-release"]);
  });

  it("reads the exact distro fields without evaluating shell syntax", () => {
    const marker = "$(touch /tmp/synara-must-not-run)";
    expect(
      parseLinuxDistribution(
        `NAME="Fedora Linux"\nID=fedora\nVERSION_ID="43"\nVERSION_CODENAME='Adams'\nID_LIKE="rhel ${marker}"\n`,
      ),
    ).toEqual({ id: "fedora", versionId: "43", versionCodename: "Adams" });
  });

  it("falls back to /usr/lib only when /etc cannot be read", () => {
    const reads: string[] = [];
    const detected = detectLinuxDistribution((path) => {
      reads.push(path);
      return path === "/etc/os-release" ? undefined : "ID=arch\n";
    });
    expect(detected).toEqual({ id: "arch" });
    expect(reads).toEqual(["/etc/os-release", "/usr/lib/os-release"]);
  });
});

describe("KWin prebuild distro mapping", () => {
  it.each([
    [{ id: "fedora", versionId: "43" }, "fedora-43"],
    [{ id: "fedora", versionId: "44" }, "fedora-44"],
    [{ id: "debian", versionId: "13", versionCodename: "trixie" }, "debian-trixie"],
    [{ id: "ubuntu", versionId: "26.04" }, "ubuntu-2604"],
    [{ id: "opensuse-tumbleweed", versionId: "20260909" }, "opensuse-tumbleweed"],
    [{ id: "arch", versionId: "rolling" }, "arch"],
  ] as const)("maps %j to %s", (distribution, builtOn) => {
    expect(prebuiltBuiltOnForDistribution(distribution)).toBe(builtOn);
  });

  it("does not treat family resemblance as exact ABI compatibility", () => {
    expect(
      prebuiltBuiltOnForDistribution({ id: "nobara", versionId: "43", versionCodename: "" }),
    ).toBeUndefined();
    expect(prebuiltBuiltOnForDistribution({ id: "debian", versionId: "12" })).toBeUndefined();
    expect(prebuiltBuiltOnForDistribution({ id: "ubuntu", versionId: "25.10" })).toBeUndefined();
  });

  it("serializes every raw field so distro release changes invalidate a stamp", () => {
    expect(linuxDistributionIdentity({ id: "fedora", versionId: "43" })).toBe("fedora:43:");
    expect(linuxDistributionIdentity({ id: "fedora", versionId: "44" })).toBe("fedora:44:");
    expect(linuxDistributionIdentity({ id: "custom:linux", versionId: "1" })).toBe(
      "custom%3Alinux:1:",
    );
  });
});
