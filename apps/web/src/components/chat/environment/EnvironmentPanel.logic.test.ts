import { describe, expect, it } from "vitest";

import { shouldShowGroupFolderRow } from "./EnvironmentPanel.logic";

describe("shouldShowGroupFolderRow", () => {
  it("shows a picked Studio reference folder only when the native shell can open it", () => {
    expect(
      shouldShowGroupFolderRow({
        isGroupChat: true,
        groupFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldShowGroupFolderRow({
        isGroupChat: true,
        groupFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: false,
      }),
    ).toBe(false);
  });

  it("hides the row outside Studio and when no folder was picked", () => {
    expect(
      shouldShowGroupFolderRow({
        isGroupChat: false,
        groupFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: true,
      }),
    ).toBe(false);
    expect(
      shouldShowGroupFolderRow({
        isGroupChat: true,
        groupFolderPath: null,
        nativeShellAvailable: true,
      }),
    ).toBe(false);
  });
});
