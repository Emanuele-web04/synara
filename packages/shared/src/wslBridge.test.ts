// Purpose: Protect workspace namespace boundaries when a Windows host launches a WSL process.
// Layer: Shared platform runtime tests; paths must remain usable by the selected backend.
import { describe, expect, it } from "vitest";

import { resolveExecutionWorkspacePath } from "./wslBridge";

describe("resolveExecutionWorkspacePath", () => {
  it("maps both WSL UNC aliases only within the launch distribution", () => {
    const cwd = "\\\\wsl.localhost\\Ubuntu\\repos\\primary";
    expect(resolveExecutionWorkspacePath("\\\\wsl$\\Ubuntu\\repos\\api", cwd, "win32")).toBe(
      "/repos/api",
    );
    expect(
      resolveExecutionWorkspacePath(
        "\\\\wsl.localhost\\ubuntu\\repos\\shared package",
        cwd,
        "win32",
      ),
    ).toBe("/repos/shared package");
  });

  it.each(["\\\\wsl$\\Debian\\repos\\api", "C:\\repos\\api", "\\\\server\\share\\api"])(
    "refuses an extra folder outside the launched distro: %s",
    (folder) => {
      expect(() =>
        resolveExecutionWorkspacePath(folder, "\\\\wsl$\\Ubuntu\\repos\\primary", "win32"),
      ).toThrow("must be in the same WSL distribution");
    },
  );

  it("keeps native Windows and POSIX launch paths literal", () => {
    expect(
      resolveExecutionWorkspacePath("C:\\repos\\shared package", "C:\\repos\\primary", "win32"),
    ).toBe("C:\\repos\\shared package");
    expect(resolveExecutionWorkspacePath("/repos/shared package", "/repos/primary", "linux")).toBe(
      "/repos/shared package",
    );
  });
});
