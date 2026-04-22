import { describe, expect, it } from "vitest";

import { isWindowsShellCommandMissingResult } from "./shell-command-detection.ts";

describe("isWindowsShellCommandMissingResult", () => {
  it("treats exit code 9009 as a missing shell command on Windows", () => {
    expect(
      isWindowsShellCommandMissingResult({
        code: 9009,
        stderr: "",
        platform: "win32",
      }),
    ).toBe(true);
  });

  it("treats the standard cmd.exe missing-command message as missing on Windows", () => {
    expect(
      isWindowsShellCommandMissingResult({
        code: 1,
        stderr: "'opencode' is not recognized as an internal or external command",
        platform: "win32",
      }),
    ).toBe(true);
  });

  it("does not flag non-Windows command failures as missing", () => {
    expect(
      isWindowsShellCommandMissingResult({
        code: 9009,
        stderr: "'opencode' is not recognized as an internal or external command",
        platform: "darwin",
      }),
    ).toBe(false);
  });
});
