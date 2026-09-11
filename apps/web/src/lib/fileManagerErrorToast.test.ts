// FILE: fileManagerErrorToast.test.ts
// Purpose: Verifies the UI toast adapter consumes the shared pure file-manager
//          presentation without owning platform-specific copy.
// Layer: Web UI helper tests

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

import { showFileManagerErrorToast } from "./fileManagerErrorToast";

beforeEach(() => {
  harness.toast.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showFileManagerErrorToast", () => {
  it("emits platform-correct folder and file failures", () => {
    showFileManagerErrorToast({
      kind: "folder",
      error: new Error("File or folder not found: C:\\repo"),
      platform: "Win32",
    });
    showFileManagerErrorToast({ kind: "file", error: new Error("nope"), platform: "MacIntel" });
    showFileManagerErrorToast({ kind: "file", error: undefined, platform: "Linux x86_64" });

    expect(harness.toast.mock.calls.map(([toast]) => toast)).toEqual([
      {
        type: "error",
        title: "Unable to open in Explorer",
        description: "File or folder not found: C:\\repo",
      },
      { type: "error", title: "Unable to reveal in Finder", description: "nope" },
      {
        type: "error",
        title: "Unable to show in folder",
        description: "The file could not be shown in its folder.",
      },
    ]);
  });

  it("defaults to navigator.platform", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });

    showFileManagerErrorToast({ kind: "folder", error: new Error("busy") });

    expect(harness.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Unable to open in Finder",
      description: "busy",
    });
  });
});
