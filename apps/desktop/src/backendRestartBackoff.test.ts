import { describe, expect, it } from "vitest";

import { BackendRestartBackoff } from "./backendRestartBackoff";

describe("BackendRestartBackoff", () => {
  it("backs off repeated startup failures up to the maximum delay", () => {
    const backoff = new BackendRestartBackoff();

    expect(Array.from({ length: 7 }, () => backoff.nextDelayMs())).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
  });

  it("resets after the backend reports readiness", () => {
    const backoff = new BackendRestartBackoff();

    backoff.nextDelayMs();
    backoff.nextDelayMs();
    backoff.reset();

    expect(backoff.nextDelayMs()).toBe(500);
  });
});
