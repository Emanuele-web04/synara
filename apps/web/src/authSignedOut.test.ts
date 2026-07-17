import { describe, expect, it, vi } from "vitest";

import { AUTH_SIGNED_OUT_PATH, bootstrapSignedOutScreen } from "./authSignedOut";

describe("bootstrapSignedOutScreen", () => {
  it("renders only on the dedicated signed-out route", () => {
    const render = vi.fn();

    expect(bootstrapSignedOutScreen({ pathname: "/", render })).toBe(false);
    expect(render).not.toHaveBeenCalled();

    expect(bootstrapSignedOutScreen({ pathname: AUTH_SIGNED_OUT_PATH, render })).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
