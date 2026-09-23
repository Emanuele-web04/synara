import { describe, expect, it } from "vitest";

import {
  commandOnPath,
  libraryRootFilePresent,
  pkgConfigModulePresent,
  systemHeaderPresent,
} from "./buildToolingProbe.ts";

const disk =
  (...present: readonly string[]) =>
  (path: string) =>
    present.includes(path);

describe("build tooling probe primitives", () => {
  it("finds commands on PATH only", () => {
    expect(commandOnPath("cmake", disk("/usr/bin/cmake"), { PATH: "/opt/bin:/usr/bin" })).toBe(
      true,
    );
    expect(commandOnPath("cmake", disk("/usr/bin/cmake"), { PATH: "/opt/bin" })).toBe(false);
    expect(commandOnPath("cmake", disk("/usr/bin/cmake"), {})).toBe(false);
  });

  it("looks for headers under the system include roots", () => {
    expect(systemHeaderPresent("vulkan/vulkan.h", disk("/usr/include/vulkan/vulkan.h"))).toBe(true);
    expect(systemHeaderPresent("vulkan/vulkan.h", disk("/usr/local/include/vulkan/vulkan.h"))).toBe(
      true,
    );
    expect(systemHeaderPresent("vulkan/vulkan.h", disk("/opt/include/vulkan/vulkan.h"))).toBe(
      false,
    );
  });

  it("looks for library-root files under every distribution's root", () => {
    for (const root of [
      "/usr/lib64",
      "/usr/lib",
      "/usr/lib/x86_64-linux-gnu",
      "/usr/lib/aarch64-linux-gnu",
    ]) {
      expect(libraryRootFilePresent("libvulkan.so", disk(`${root}/libvulkan.so`))).toBe(true);
    }
    expect(libraryRootFilePresent("libvulkan.so", disk("/opt/lib/libvulkan.so"))).toBe(false);
  });

  it("follows pkg-config's search path, including its environment overrides", () => {
    expect(pkgConfigModulePresent("cairo", disk("/usr/lib/pkgconfig/cairo.pc"), {})).toBe(true);
    expect(pkgConfigModulePresent("cairo", disk("/usr/share/pkgconfig/cairo.pc"), {})).toBe(true);
    expect(
      pkgConfigModulePresent("cairo", disk("/opt/pc/cairo.pc"), { PKG_CONFIG_PATH: "/opt/pc" }),
    ).toBe(true);
    // PKG_CONFIG_LIBDIR replaces the default directories rather than adding to them.
    expect(
      pkgConfigModulePresent("cairo", disk("/usr/lib/pkgconfig/cairo.pc"), {
        PKG_CONFIG_LIBDIR: "/sysroot/lib/pkgconfig",
      }),
    ).toBe(false);
    expect(
      pkgConfigModulePresent("cairo", disk("/sysroot/lib/pkgconfig/cairo.pc"), {
        PKG_CONFIG_LIBDIR: "/sysroot/lib/pkgconfig",
      }),
    ).toBe(true);
  });
});
