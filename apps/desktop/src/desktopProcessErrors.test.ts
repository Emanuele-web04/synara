import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { handleDesktopStdioError, isBrokenPipeError } from "./desktopProcessErrors";

describe("desktop stdio errors", () => {
  it("consumes a closed launcher pipe while preserving other failures", async () => {
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(error);
      },
    });
    output.on("error", handleDesktopStdioError);
    const closed = new Promise<void>((resolve) => output.once("close", resolve));
    output.write("desktop log line");
    await closed;
    const unexpected = Object.assign(new Error("write EIO"), { code: "EIO" });
    expect(() => handleDesktopStdioError(unexpected)).toThrow(unexpected);
  });
});

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
