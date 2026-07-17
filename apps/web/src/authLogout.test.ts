import { describe, expect, it, vi } from "vitest";

import { AUTH_SIGNED_OUT_PATH } from "./authSignedOut";
import { logoutCurrentBrowserSession } from "./authLogout";

describe("logoutCurrentBrowserSession", () => {
  it("revokes once and replaces the authenticated app on confirmation", async () => {
    const logout = vi.fn().mockResolvedValue({ revoked: true });
    const navigate = vi.fn();
    const onError = vi.fn();

    await expect(
      logoutCurrentBrowserSession({
        confirm: async () => true,
        logout,
        navigate,
        onError,
      }),
    ).resolves.toBe("redirecting");

    expect(logout).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(AUTH_SIGNED_OUT_PATH);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps the authenticated app usable on cancellation or failure", async () => {
    const cancelledLogout = vi.fn();
    const navigate = vi.fn();
    const onError = vi.fn();
    await expect(
      logoutCurrentBrowserSession({
        confirm: async () => false,
        logout: cancelledLogout,
        navigate,
        onError,
      }),
    ).resolves.toBe("cancelled");
    expect(cancelledLogout).not.toHaveBeenCalled();

    const failure = new Error("network unavailable");
    await expect(
      logoutCurrentBrowserSession({
        confirm: async () => true,
        logout: async () => Promise.reject(failure),
        navigate,
        onError,
      }),
    ).resolves.toBe("failed");
    expect(navigate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
