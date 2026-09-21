import { describe, expect, it } from "vitest";

import { openUsageProviderSnapshotQueryOptions } from "./openUsageReactQuery";

describe("openUsageProviderSnapshotQueryOptions", () => {
  it("can be disabled by privacy-safe active surfaces", () => {
    const options = openUsageProviderSnapshotQueryOptions("cursor", { enabled: false });

    expect(options.enabled).toBe(false);
  });
});
