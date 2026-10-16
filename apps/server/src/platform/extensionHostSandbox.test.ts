import { describe, expect, it } from "vitest";
import {
  extensionSandboxArguments,
  extensionSandboxEnvironment,
  pathWithin,
} from "./extensionHostSandbox";

describe("extension host sandbox boundary", () => {
  it("mounts the workspace, packages and runtime read-only, with only allocated storage writable", () => {
    const input = {
      workspace: "/work/project",
      packages: "/state/editor-extensions/packages",
      storage: "/state/editor-extensions/runtime/one",
      stateDir: "/state",
      runtime: "/app/code-oss/extension-host.mjs",
      node: "/opt/node/bin/node",
    };
    const args = extensionSandboxArguments(input, ["/usr", "/lib"]);
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
    expect(args).not.toContain("--share-net");
    expect(args.filter((arg) => arg === "--bind")).toHaveLength(1);
    expect(args.slice(args.indexOf("--bind"), args.indexOf("--bind") + 3)).toEqual([
      "--bind",
      input.storage,
      input.storage,
    ]);
    for (const directory of [input.workspace, input.packages, "/app/code-oss", "/opt/node/bin"]) {
      const offset = args.indexOf(directory);
      expect(args[offset - 1]).toBe("--ro-bind");
    }
  });
  it("constructs a small environment without inherited credentials or injection flags", () => {
    const environment = extensionSandboxEnvironment("/state/runtime", "/opt/node/bin/node");
    expect(environment.HOME).toBe("/state/runtime/home");
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.SYNARA_AUTH_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.LD_PRELOAD).toBeUndefined();
    expect(Object.keys(environment).sort()).toEqual(
      [
        "HOME",
        "LANG",
        "LC_ALL",
        "NO_COLOR",
        "PATH",
        "TEMP",
        "TMP",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
      ].sort(),
    );
  });
  it("does not confuse prefix siblings with descendants", () => {
    expect(pathWithin("/workspace", "/workspace/file.ts")).toBe(true);
    expect(pathWithin("/workspace", "/workspace-other/file.ts")).toBe(false);
    expect(pathWithin("/workspace", "/outside")).toBe(false);
  });
});
