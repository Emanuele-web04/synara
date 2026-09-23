import { describe, expect, it } from "vitest";

import { readHostKwinVersion, type HostToolchainReaders } from "./hostToolchain.ts";

function readers(files: Record<string, string>, listings: Record<string, string[]>) {
  return {
    readFile: (path) => files[path],
    listDirectory: (path) => listings[path] ?? [],
  } satisfies HostToolchainReaders;
}

describe("readHostKwinVersion", () => {
  it("reads KWin's version off disk, never off kwin_wayland", () => {
    // The development package's cmake version file first.
    expect(
      readHostKwinVersion(
        readers(
          { "/usr/lib/cmake/KWin/KWinConfigVersion.cmake": 'set(PACKAGE_VERSION "6.7.4")' },
          {},
        ),
      ),
    ).toBe("6.7.4");
    // Without it, the versioned library every KWin package installs.
    expect(
      readHostKwinVersion(
        readers({}, { "/usr/lib64": ["libkwin.so", "libkwin.so.6", "libkwin.so.6.7.3"] }),
      ),
    ).toBe("6.7.3");
    expect(readHostKwinVersion(readers({}, {}))).toBeUndefined();
  });
});
