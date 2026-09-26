import { describe, expect, it } from "vitest";

import { parseWindowsWindowProbeOutput, windowsWindowProbeHelperName } from "./windowsWindowProbe";

describe("windowsWindowProbe", () => {
  it("parses foreground and owned HWND lines from probe stdout", () => {
    const result = parseWindowsWindowProbeOutput(
      [
        "foreground 67890",
        "owned 111\tSynara",
        "owned 123\tDeveloper Tools - http://localhost:5733/",
        "",
      ].join("\n"),
    );
    expect(result.foregroundHwnd).toBe(67890n);
    expect(result.ownedHwnds).toEqual(new Set(["111", "123"]));
  });

  it("treats a zero or missing foreground handle as null", () => {
    expect(parseWindowsWindowProbeOutput("foreground 0\n").foregroundHwnd).toBeNull();
    expect(parseWindowsWindowProbeOutput("").foregroundHwnd).toBeNull();
    expect(parseWindowsWindowProbeOutput("foreground nope\n").foregroundHwnd).toBeNull();
  });

  it("derives a stable helper name from the probe source", () => {
    expect(windowsWindowProbeHelperName()).toMatch(/^windows-window-probe-[0-9a-f]{12}\.exe$/);
  });
});
