// FILE: providerUsageSnapshot.test.ts
// Purpose: Locks down provider-usage snapshot normalization edge cases used by
// compact usage surfaces and Settings usage cards.

import type { ServerProviderUsageSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isProviderUsageSnapshotNonOk } from "./providerUsageSnapshot";

function snapshot(input: Partial<ServerProviderUsageSnapshot> = {}): ServerProviderUsageSnapshot {
  return {
    provider: "claudeAgent",
    updatedAt: "2026-06-09T12:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "test",
    ...input,
  };
}

describe("providerUsageSnapshot", () => {
  it("only treats explicit non-ok live statuses as fallback blockers", () => {
    expect(isProviderUsageSnapshotNonOk(null)).toBe(false);
    expect(isProviderUsageSnapshotNonOk(undefined)).toBe(false);
    expect(isProviderUsageSnapshotNonOk(snapshot())).toBe(false);
    expect(isProviderUsageSnapshotNonOk(snapshot({ status: "ok" }))).toBe(false);

    expect(isProviderUsageSnapshotNonOk(snapshot({ status: "needs-auth" }))).toBe(true);
    expect(isProviderUsageSnapshotNonOk(snapshot({ status: "unsupported" }))).toBe(true);
    expect(isProviderUsageSnapshotNonOk(snapshot({ status: "error" }))).toBe(true);
  });
});
