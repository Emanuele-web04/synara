import { describe, expect, it, vi } from "vitest";

import { readEnvironmentFromLoginShell, readPathFromLoginShell } from "./shell";

type ShellExec = NonNullable<Parameters<typeof readEnvironmentFromLoginShell>[2]>;

describe("Nushell environment capture", () => {
  it.each(["nu", "/opt/homebrew/bin/nu", "C:\\Program Files\\nu\\nu.exe"])(
    "uses Nu syntax and loads interactive/login configuration for %s",
    (shell) => {
      const execFile = vi.fn<ShellExec>(
        () => "__SYNARA_ENV_PATH_START__\n/mise/shims:/bin\n__SYNARA_ENV_PATH_END__\n",
      );

      expect(readPathFromLoginShell(shell, execFile)).toBe("/mise/shims:/bin");
      expect(execFile).toHaveBeenCalledWith(
        shell,
        [
          "--login",
          "--interactive",
          "--commands",
          "print '__SYNARA_ENV_PATH_START__'; do { ^printenv PATH } | complete | get stdout | print --no-newline; print '__SYNARA_ENV_PATH_END__'",
        ],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      );
    },
  );

  it("keeps requested values intact and continues after an unset variable", () => {
    const execFile = vi.fn<ShellExec>(() =>
      [
        "startup banner",
        "__SYNARA_ENV_MISSING_START__",
        "__SYNARA_ENV_MISSING_END__",
        "__SYNARA_ENV_PATH_START__",
        "/Users/example/My Tools:/bin",
        "__SYNARA_ENV_PATH_END__",
        "__SYNARA_ENV_CUSTOM_VAR_START__",
        "  first line\nsecond line  ",
        "__SYNARA_ENV_CUSTOM_VAR_END__",
      ].join("\n"),
    );

    expect(
      readEnvironmentFromLoginShell("/usr/bin/nu", ["MISSING", "PATH", "CUSTOM_VAR"], execFile),
    ).toEqual({ PATH: "/Users/example/My Tools:/bin", CUSTOM_VAR: "  first line\nsecond line  " });
    const args = execFile.mock.calls[0]?.[1];
    expect(args?.[3]).toContain("do { ^printenv MISSING } | complete | get stdout");
    expect(args?.[3]).not.toContain("||");
  });

  it.each(["/bin/bash", "/bin/zsh", "/usr/bin/fish", "/opt/nu/bin/menu"])(
    "preserves the existing probe for %s",
    (shell) => {
      const execFile = vi.fn<ShellExec>(() => "");
      readPathFromLoginShell(shell, execFile);

      expect(execFile).toHaveBeenCalledWith(
        shell,
        [
          "-ilc",
          "printf '%s\\n' '__SYNARA_ENV_PATH_START__'; printenv PATH || true; printf '%s\\n' '__SYNARA_ENV_PATH_END__'",
        ],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      );
    },
  );

  it("validates every requested name before spawning Nu", () => {
    const execFile = vi.fn<ShellExec>(() => "");
    expect(() =>
      readEnvironmentFromLoginShell("nu", ["PATH", "BAD; print unexpected"], execFile),
    ).toThrow("Unsupported environment variable name");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("does not spawn Nu when no variables are requested", () => {
    const execFile = vi.fn<ShellExec>(() => "");
    expect(readEnvironmentFromLoginShell("nu", [], execFile)).toEqual({});
    expect(execFile).not.toHaveBeenCalled();
  });
});
