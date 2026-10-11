import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lowerProcessPriority } from "./platformProcess";

describe("lowerProcessPriority", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["darwin", "linux"] as const)("uses moderate CPU priority on %s", (platform) => {
    vi.spyOn(os, "getPriority").mockReturnValue(0);
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    lowerProcessPriority(12345, { platform });
    expect(setPriority).toHaveBeenCalledWith(12345, 5);
  });

  it("uses the below-normal class on Windows", () => {
    vi.spyOn(os, "getPriority").mockReturnValue(0);
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    lowerProcessPriority(12345, { platform: "win32" });
    expect(setPriority).toHaveBeenCalledWith(12345, os.constants.priority.PRIORITY_BELOW_NORMAL);
  });

  it("does not raise an already lower priority", () => {
    vi.spyOn(os, "getPriority").mockReturnValue(15);
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    lowerProcessPriority(12345, { platform: "linux" });
    expect(setPriority).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, NaN, process.pid])(
    "never reprioritizes an invalid or server PID: %s",
    (pid) => {
      const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
      lowerProcessPriority(pid);
      expect(setPriority).not.toHaveBeenCalled();
    },
  );

  it.each(["getPriority", "setPriority"] as const)("logs and ignores %s failures", (operation) => {
    vi.spyOn(os, "getPriority").mockReturnValue(0);
    vi.spyOn(os, "setPriority").mockImplementation(() => {});
    vi.spyOn(os, operation).mockImplementation(() => {
      throw new Error("access denied");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => lowerProcessPriority(12345)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("12345"), expect.any(Error));
  });
});
