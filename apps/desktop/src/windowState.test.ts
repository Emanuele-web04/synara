import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseDesktopWindowState,
  readDesktopWindowState,
  resolveVisibleWindowBounds,
  writeDesktopWindowState,
} from "./windowState";

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop window state", () => {
  it("parses a valid persisted state and rejects malformed bounds", () => {
    expect(
      parseDesktopWindowState({
        version: 1,
        bounds: { x: 120, y: 80, width: 1100, height: 780 },
        isMaximized: false,
      }),
    ).toEqual({
      version: 1,
      bounds: { x: 120, y: 80, width: 1100, height: 780 },
      isMaximized: false,
    });
    expect(
      parseDesktopWindowState({
        version: 1,
        bounds: { x: 0, y: 0, width: -1, height: 780 },
        isMaximized: false,
      }),
    ).toBeNull();
  });

  it("round-trips state through the filesystem", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-window-state-"));
    temporaryDirectories.push(directory);
    const filePath = Path.join(directory, "nested", "window-state.json");
    const state = {
      version: 1,
      bounds: { x: 40, y: 50, width: 1280, height: 800 },
      isMaximized: true,
    } as const;

    writeDesktopWindowState(filePath, state);

    expect(readDesktopWindowState(filePath)).toEqual(state);
  });

  it("keeps visible bounds unchanged", () => {
    expect(
      resolveVisibleWindowBounds({
        savedBounds: { x: 100, y: 90, width: 1200, height: 800 },
        displayWorkAreas: [workArea],
        minimumWidth: 840,
        minimumHeight: 620,
      }),
    ).toEqual({ x: 100, y: 90, width: 1200, height: 800 });
  });

  it("centers off-screen bounds on the primary display and clamps their size", () => {
    expect(
      resolveVisibleWindowBounds({
        savedBounds: { x: 4000, y: 3000, width: 2400, height: 1600 },
        displayWorkAreas: [workArea],
        minimumWidth: 840,
        minimumHeight: 620,
      }),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it("restores a window onto the display where most of it was visible", () => {
    expect(
      resolveVisibleWindowBounds({
        savedBounds: { x: 2100, y: 100, width: 1000, height: 700 },
        displayWorkAreas: [workArea, { x: 1920, y: 0, width: 1920, height: 1040 }],
        minimumWidth: 840,
        minimumHeight: 620,
      }),
    ).toEqual({ x: 2100, y: 100, width: 1000, height: 700 });
  });
});
