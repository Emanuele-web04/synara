import { describe, expect, it } from "vitest";

import {
  isLocalPreviewGrantUsable,
  LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS,
  localPreviewGrantRefetchIntervalMs,
  projectLocalPreviewGrantQueryOptions,
} from "./projectReactQuery";

describe("local preview grant query options", () => {
  it("refreshes active preview grants before the server-side token expires", () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs + 120_000).toISOString() },
        nowMs,
      ),
    ).toBe(LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS);
    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs + 20_000).toISOString() },
        nowMs,
      ),
    ).toBe(5_000);
    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs - 1_000).toISOString() },
        nowMs,
      ),
    ).toBe(1_000);
  });

  it("does not treat expired cached grants as usable preview URLs", () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(
      isLocalPreviewGrantUsable({ expiresAt: new Date(nowMs + 2_000).toISOString() }, nowMs),
    ).toBe(true);
    expect(
      isLocalPreviewGrantUsable({ expiresAt: new Date(nowMs + 500).toISOString() }, nowMs),
    ).toBe(false);
  });

  it("wires the refresh interval into the React Query options", () => {
    const options = projectLocalPreviewGrantQueryOptions({ path: "/Users/me/Downloads/shot.png" });
    const refetchInterval = options.refetchInterval;

    expect(typeof refetchInterval).toBe("function");
    if (typeof refetchInterval !== "function") {
      throw new Error("Expected refetchInterval to be a function.");
    }
    expect(
      refetchInterval({
        state: { data: { grant: "grant-token", expiresAt: "not-a-date" } },
      } as never),
    ).toBe(LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS);
  });
});
