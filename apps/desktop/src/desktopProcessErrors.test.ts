import { describe, expect, it } from "vitest";

import { isBrokenPipeError } from "./desktopProcessErrors";

describe("isBrokenPipeError", () => {
  it("recognizes stderr broken pipe errors", () => {
    const error = new Error("write EPIPE") as NodeJS.ErrnoException;
    error.code = "EPIPE";

    expect(isBrokenPipeError(error)).toBe(true);
  });

  it("ignores other process errors", () => {
    const error = new Error("connection reset") as NodeJS.ErrnoException;
    error.code = "ECONNRESET";

    expect(isBrokenPipeError(error)).toBe(false);
  });

  it("ignores non-error values", () => {
    expect(isBrokenPipeError("EPIPE")).toBe(false);
    expect(isBrokenPipeError(null)).toBe(false);
  });
});
