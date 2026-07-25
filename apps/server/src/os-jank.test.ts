// FILE: os-jank.test.ts
// Purpose: Verifies PATH hydration keeps inherited entries and macOS fallbacks.

import { describe, expect, it, vi } from "vitest";

import { fixPath } from "./os-jank";

describe("fixPath", () => {
  it("hydrates PATH on linux using the resolved login shell", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/Users/test/.local/bin:/usr/bin",
    };
    const readPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");

    fixPath({
      env,
      platform: "linux",
      readPath,
    });

    expect(readPath).toHaveBeenCalledWith("/bin/zsh");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  });

  it("falls back to launchctl PATH on macOS when shell probing fails", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/opt/homebrew/bin/nu",
      PATH: "/usr/bin",
    };
    const readPath = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("unknown flag");
      })
      .mockImplementationOnce(() => undefined);
    const readLaunchctlPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");
    const logWarning = vi.fn();

    fixPath({
      env,
      platform: "darwin",
      readPath,
      readLaunchctlPath,
      userShell: "/bin/zsh",
      logWarning,
    });

    expect(readPath).toHaveBeenNthCalledWith(1, "/opt/homebrew/bin/nu");
    expect(readPath).toHaveBeenNthCalledWith(2, "/bin/zsh");
    expect(readLaunchctlPath).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(
      "Failed to read PATH from login shell /opt/homebrew/bin/nu.",
      expect.any(Error),
    );
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("skips the probe when a parent process marked the environment hydrated", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/opt/homebrew/bin:/usr/bin",
      SYNARA_PATH_HYDRATED: "1",
    };
    const readPath = vi.fn(() => "/should/not/run");
    const readLaunchctlPath = vi.fn(() => "/should/not/run");

    fixPath({
      env,
      platform: "darwin",
      readPath,
      readLaunchctlPath,
    });

    expect(readPath).not.toHaveBeenCalled();
    expect(readLaunchctlPath).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  // A populated PATH is not evidence of hydration: every process inherits one.
  it("still probes when PATH is populated but the hydration marker is absent", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
    };
    const readPath = vi.fn(() => "/opt/homebrew/bin");

    fixPath({ env, platform: "darwin", readPath });

    expect(readPath).toHaveBeenCalledTimes(1);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("still probes when the marker is set to an unexpected value", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SYNARA_PATH_HYDRATED: "0",
    };
    const readPath = vi.fn(() => "/opt/homebrew/bin");

    fixPath({ env, platform: "linux", readPath });

    expect(readPath).toHaveBeenCalledTimes(1);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("still probes when the marker is present but PATH is empty", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "",
      SYNARA_PATH_HYDRATED: "1",
    };
    const readPath = vi.fn(() => "/opt/homebrew/bin");

    fixPath({ env, platform: "linux", readPath });

    expect(readPath).toHaveBeenCalledTimes(1);
    expect(env.PATH).toBe("/opt/homebrew/bin");
  });

  it("does nothing on unsupported platforms", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "C:/Program Files/Git/bin/bash.exe",
      PATH: "C:/Windows/System32",
    };
    const readPath = vi.fn(() => "C:/Git/bin");

    fixPath({
      env,
      platform: "win32",
      readPath,
    });

    expect(readPath).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:/Windows/System32");
  });
});
