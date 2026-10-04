// FILE: openUsageReactQuery.test.ts
// Purpose: Locks down OpenUsage polling query gates for privacy-safe usage surfaces.

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeFakeWindow } from "../storeTestFixtures";
import { openUsageProviderSnapshotQueryOptions } from "./openUsageReactQuery";

describe("openUsageProviderSnapshotQueryOptions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("can be disabled by privacy-safe active surfaces", () => {
    const storage = new Map([["synara.openUsage.enabled", "true"]]);
    vi.stubGlobal("window", makeFakeWindow(storage));

    expect(openUsageProviderSnapshotQueryOptions("codex").enabled).toBe(true);
    expect(openUsageProviderSnapshotQueryOptions("codex", { enabled: false }).enabled).toBe(false);
  });
});
