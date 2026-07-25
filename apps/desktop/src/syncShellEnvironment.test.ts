import { describe, expect, it, vi } from "vitest";

import { syncShellEnvironment } from "./syncShellEnvironment";

describe("syncShellEnvironment", () => {
  it("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on macOS", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/Users/test/.local/bin:/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
      HOMEBREW_PREFIX: "/opt/homebrew",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", [
      "PATH",
      "SSH_AUTH_SOCK",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
    expect(env.HOMEBREW_PREFIX).toBe("/opt/homebrew");
  });

  it("preserves an inherited SSH_AUTH_SOCK value", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/login-shell.sock",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("preserves inherited values when the login shell omits them", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on Linux", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/usr/local/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
    }));

    syncShellEnvironment(env, {
      platform: "linux",
      readEnvironment,
    });

    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", [
      "PATH",
      "SSH_AUTH_SOCK",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh.sock");
  });

  it("falls back to a user login shell when SHELL is missing", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/usr/local/bin:/usr/bin",
    }));

    syncShellEnvironment(env, {
      platform: "linux",
      readEnvironment,
      userShell: "/bin/bash",
    });

    expect(readEnvironment).toHaveBeenCalledWith("/bin/bash", [
      "PATH",
      "SSH_AUTH_SOCK",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
  });

  it("falls back to launchctl PATH on macOS when shell probing does not return one", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/opt/homebrew/bin/nu",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("unknown flag");
      })
      .mockImplementationOnce(() => ({}));
    const readLaunchctlPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");
    const logWarning = vi.fn();

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
      readLaunchctlPath,
      userShell: "/bin/zsh",
      logWarning,
    });

    expect(readEnvironment).toHaveBeenNthCalledWith(1, "/opt/homebrew/bin/nu", [
      "PATH",
      "SSH_AUTH_SOCK",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    expect(readEnvironment).toHaveBeenNthCalledWith(2, "/bin/zsh", [
      "PATH",
      "SSH_AUTH_SOCK",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    expect(readLaunchctlPath).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(
      "Failed to read login shell environment from /opt/homebrew/bin/nu.",
      expect.any(Error),
    );
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("hydrates PATH and missing variables from the Windows registry", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\system32",
    };
    const readWindowsEnvironment = vi.fn(() => ({
      PATH: "C:\\Windows\\system32;C:\\Users\\ramar\\.local\\bin",
      CLAUDE_CONFIG_DIR: "C:\\Users\\ramar\\.config\\claude",
    }));

    syncShellEnvironment(env, {
      platform: "win32",
      readWindowsEnvironment,
    });

    expect(readWindowsEnvironment).toHaveBeenCalledTimes(1);
    expect(env.PATH).toBe("C:\\Windows\\system32;C:\\Users\\ramar\\.local\\bin");
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\Users\\ramar\\.config\\claude");
  });

  it("merges Windows PATH but preserves variables already in the environment", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\system32",
      CLAUDE_CONFIG_DIR: "C:\\already\\set",
    };
    const readWindowsEnvironment = vi.fn(() => ({
      PATH: "C:\\Users\\ramar\\.local\\bin",
      CLAUDE_CONFIG_DIR: "C:\\Users\\ramar\\.config\\claude",
      GEMINI_API_KEY: "from-registry",
    }));

    syncShellEnvironment(env, {
      platform: "win32",
      readWindowsEnvironment,
    });

    expect(env.PATH).toBe("C:\\Users\\ramar\\.local\\bin;C:\\Windows\\system32");
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\already\\set");
    expect(env.GEMINI_API_KEY).toBe("from-registry");
  });

  it("logs a warning and leaves the environment intact when the Windows reader throws", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\system32",
    };
    const readWindowsEnvironment = vi.fn(() => {
      throw new Error("powershell.exe ENOENT");
    });
    const logWarning = vi.fn();

    syncShellEnvironment(env, {
      platform: "win32",
      readWindowsEnvironment,
      logWarning,
    });

    expect(readWindowsEnvironment).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(
      "Failed to synchronize the desktop Windows environment.",
      expect.any(Error),
    );
    expect(env.PATH).toBe("C:\\Windows\\system32");
  });

  // The result is what lets the backend child skip its own ~1s login-shell probe, so
  // it must be true only when PATH really came from the user's environment.
  it("reports PATH as hydrated when the login shell supplied one", () => {
    const result = syncShellEnvironment(
      { SHELL: "/bin/zsh", PATH: "/usr/bin" },
      {
        platform: "darwin",
        readEnvironment: () => ({ PATH: "/opt/homebrew/bin:/usr/bin" }),
      },
    );

    expect(result).toEqual({ pathHydrated: true });
  });

  it("reports PATH as hydrated when only launchctl supplied one", () => {
    const result = syncShellEnvironment(
      { SHELL: "/bin/zsh", PATH: "/usr/bin" },
      {
        platform: "darwin",
        readEnvironment: () => ({}),
        readLaunchctlPath: () => "/opt/homebrew/bin",
      },
    );

    expect(result).toEqual({ pathHydrated: true });
  });

  it("reports PATH as not hydrated when neither the shell nor launchctl supplied one", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    const result = syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment: () => ({}),
      readLaunchctlPath: () => undefined,
    });

    expect(result).toEqual({ pathHydrated: false });
    expect(env.PATH).toBe("/usr/bin");
  });

  it("reports PATH as not hydrated when every login shell probe throws", () => {
    const result = syncShellEnvironment(
      { SHELL: "/bin/zsh", PATH: "/usr/bin" },
      {
        platform: "linux",
        readEnvironment: () => {
          throw new Error("probe failed");
        },
        logWarning: vi.fn(),
      },
    );

    expect(result).toEqual({ pathHydrated: false });
  });

  it("reports Windows registry hydration through the same result", () => {
    expect(
      syncShellEnvironment(
        { PATH: "C:\\Windows\\system32" },
        {
          platform: "win32",
          readWindowsEnvironment: () => ({ PATH: "C:\\Users\\ramar\\.local\\bin" }),
        },
      ),
    ).toEqual({ pathHydrated: true });

    expect(
      syncShellEnvironment(
        { PATH: "C:\\Windows\\system32" },
        {
          platform: "win32",
          readWindowsEnvironment: () => ({ CLAUDE_CONFIG_DIR: "C:\\config" }),
        },
      ),
    ).toEqual({ pathHydrated: false });

    expect(
      syncShellEnvironment(
        { PATH: "C:\\Windows\\system32" },
        {
          platform: "win32",
          readWindowsEnvironment: () => {
            throw new Error("powershell.exe ENOENT");
          },
          logWarning: vi.fn(),
        },
      ),
    ).toEqual({ pathHydrated: false });
  });

  it("reports PATH as not hydrated on unsupported platforms", () => {
    expect(
      syncShellEnvironment({ PATH: "/usr/bin" }, { platform: "freebsd", readEnvironment: vi.fn() }),
    ).toEqual({ pathHydrated: false });
  });

  it("does nothing on unsupported platforms", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    syncShellEnvironment(env, {
      platform: "freebsd",
      readEnvironment,
    });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });
});
