import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runBoundedNodeProcess: vi.fn() }));

vi.mock("./boundedNodeProcess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./boundedNodeProcess")>();
  return { ...actual, runBoundedNodeProcess: mocks.runBoundedNodeProcess };
});

import { BoundedNodeProcessError } from "./boundedNodeProcess";
import { inventoryChromiumPasswordProfileProcess } from "./chromiumPasswordReadProcess";

describe("Chromium password child process error mapping", () => {
  afterEach(() => mocks.runBoundedNodeProcess.mockReset());

  it.each([
    ["input_too_large", "source_too_large"],
    ["output_too_large", "source_too_large"],
    ["timed_out", "timed_out"],
    ["process_failed", "reader_failed"],
  ] as const)("maps bounded process failure %s to %s", async (processCode, expectedCode) => {
    mocks.runBoundedNodeProcess.mockRejectedValue(new BoundedNodeProcessError(processCode));

    await expect(
      inventoryChromiumPasswordProfileProcess(
        "/tmp/synara-password-profile",
        "chrome",
        "Default",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: expectedCode });
  });
});
