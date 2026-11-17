import { describe, expect, it } from "vitest";

import { frameReconnectDelayMs } from "./binaryFrameSource";

describe("frameReconnectDelayMs", () => {
  it("doubles from 500 ms and caps at 5 s", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(frameReconnectDelayMs)).toEqual([
      500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000,
    ]);
  });
});
