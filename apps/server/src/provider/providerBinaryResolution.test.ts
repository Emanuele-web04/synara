import { describe, expect, it } from "vitest";

import {
  appendDirectoriesToPathEnv,
  directoriesContainingCommand,
  openCodeBinarySearchDirectories,
} from "./providerBinaryResolution.ts";

const missingPath = () => false;

describe("openCodeBinarySearchDirectories", () => {
  it("includes installer, bun, local, and version-manager bin dirs under HOME on posix", () => {
    const dirs = openCodeBinarySearchDirectories({
      platform: "darwin",
      env: { HOME: "/home/test" },
      pathExists: missingPath,
    });
    expect(dirs).toContain("/home/test/.opencode/bin");
    expect(dirs).toContain("/home/test/.bun/bin");
    expect(dirs).toContain("/home/test/.local/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/home/test/.local/share/pnpm");
    expect(dirs).toContain("/home/test/Library/pnpm");
    expect(dirs).toContain("/home/test/.yarn/bin");
    // The installer's own dir leads the list.
    expect(dirs[0]).toBe("/home/test/.opencode/bin");
  });

  it("honors PNPM_HOME and npm_config_prefix on posix", () => {
    const dirs = openCodeBinarySearchDirectories({
      platform: "linux",
      env: {
        HOME: "/home/test",
        PNPM_HOME: "/opt/custom/pnpm",
        npm_config_prefix: "/opt/npm-prefix",
      },
      pathExists: missingPath,
    });
    expect(dirs).toContain("/opt/custom/pnpm");
    expect(dirs).toContain("/opt/npm-prefix/bin");
  });

  it("honors PNPM_HOME and npm_config_prefix without HOME on posix", () => {
    const dirs = openCodeBinarySearchDirectories({
      platform: "linux",
      env: {
        PNPM_HOME: "/opt/custom/pnpm",
        npm_config_prefix: "/opt/npm-prefix",
      },
      pathExists: missingPath,
    });
    expect(dirs).toContain("/opt/custom/pnpm");
    expect(dirs).toContain("/opt/npm-prefix/bin");
  });

  it("includes installer, bun, scoop, and npm dirs under USERPROFILE on windows", () => {
    const dirs = openCodeBinarySearchDirectories({
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\test", PNPM_HOME: "D:\\pnpm-home" },
      pathExists: missingPath,
    });
    expect(dirs).toContain("C:\\Users\\test\\.opencode\\bin");
    expect(dirs).toContain("C:\\Users\\test\\AppData\\Local\\Programs\\opencode");
    expect(dirs).toContain("C:\\Users\\test\\.bun\\bin");
    expect(dirs).toContain("C:\\Users\\test\\scoop\\shims");
    expect(dirs).toContain("C:\\Users\\test\\AppData\\Roaming\\npm");
    expect(dirs).toContain("C:\\Users\\test\\AppData\\Local\\pnpm");
    expect(dirs).toContain("C:\\Users\\test\\AppData\\Local\\Yarn\\bin");
    expect(dirs).toContain("D:\\pnpm-home");
  });
});

describe("directoriesContainingCommand", () => {
  it("keeps only directories holding an executable command file on posix", () => {
    const dirs = directoriesContainingCommand(
      "opencode",
      ["/opt/a/bin", "/opt/b/bin", "/opt/c/bin"],
      {
        platform: "linux",
        env: {},
        isExecutable: (path) => path === "/opt/a/bin/opencode" || path === "/opt/c/bin/opencode",
      },
    );
    expect(dirs).toEqual(["/opt/a/bin", "/opt/c/bin"]);
  });

  it("matches PATHEXT executable names on windows", () => {
    const dirs = directoriesContainingCommand("opencode", ["C:\\tools\\oc", "D:\\none"], {
      platform: "win32",
      env: { PATHEXT: ".EXE;.CMD" },
      isExecutable: (path) => path === "C:\\tools\\oc\\opencode.EXE",
    });
    expect(dirs).toEqual(["C:\\tools\\oc"]);
  });
});

describe("appendDirectoriesToPathEnv", () => {
  it("appends only directories that exist, preserving PATH order", () => {
    const env = appendDirectoriesToPathEnv(
      { PATH: "/usr/bin", HOME: "/home/test" },
      ["/opt/opencode/bin", "/missing/bin", "/opt/bun/bin"],
      {
        platform: "darwin",
        pathExists: (path) => path !== "/missing/bin",
      },
    );
    expect(env.PATH).toBe("/usr/bin:/opt/opencode/bin:/opt/bun/bin");
  });

  it("deduplicates directories already on PATH", () => {
    const env = appendDirectoriesToPathEnv(
      { PATH: "/usr/bin:/opt/opencode/bin" },
      ["/opt/opencode/bin", "/opt/bun/bin"],
      { platform: "linux", pathExists: () => true },
    );
    expect(env.PATH).toBe("/usr/bin:/opt/opencode/bin:/opt/bun/bin");
  });

  it("respects the Windows Path key casing and separator", () => {
    const env = appendDirectoriesToPathEnv(
      { Path: "C:\\Windows" },
      ["C:\\tools\\opencode", "C:\\other"],
      { platform: "win32", pathExists: () => true },
    );
    expect(env.Path).toBe("C:\\Windows;C:\\tools\\opencode;C:\\other");
    expect(env.PATH).toBeUndefined();
  });

  it("returns the env unchanged when nothing exists to append", () => {
    const env = appendDirectoriesToPathEnv({ PATH: "/usr/bin" }, ["/nope/bin"], {
      platform: "darwin",
      pathExists: missingPath,
    });
    expect(env.PATH).toBe("/usr/bin");
  });
});
