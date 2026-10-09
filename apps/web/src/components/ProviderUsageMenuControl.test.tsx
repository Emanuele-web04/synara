import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildProviderUsageMenuModel } from "./ProviderUsageMenuControl";

function snapshot(input: Partial<ServerProviderUsageSnapshot> = {}): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    instanceId: "codex_work",
    updatedAt: "2026-10-09T12:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "test",
    ...input,
  };
}

const emptySummary = {
  learnMoreHref: null,
  rateLimits: [],
  usageLines: [],
  usageNotice: undefined,
  isLoading: false,
};

describe("buildProviderUsageMenuModel", () => {
  it.each([
    ["needs-auth", "Sign in to Work."],
    ["unsupported", "This account has no live usage source."],
    ["error", "Usage could not be read for this account."],
  ] as const)(
    "uses the resolved %s snapshot's detail when no snapshot prop was provided",
    (status, detail) => {
      const model = buildProviderUsageMenuModel({
        provider: "codex",
        usageSummary: { ...emptySummary, providerSnapshot: snapshot({ status, detail }) },
      });

      expect(model.emptyMessage).toBe(detail);
      expect(model.rows).toEqual([]);
      expect(model.isLoading).toBe(false);
    },
  );

  it("keeps the caller's explicit snapshot authoritative over a cached fallback", () => {
    const model = buildProviderUsageMenuModel({
      provider: "codex",
      providerSnapshot: snapshot({ status: "needs-auth", detail: "Sign in to Work." }),
      usageSummary: {
        ...emptySummary,
        providerSnapshot: snapshot({ status: "error", detail: "Unrelated cached error." }),
      },
    });

    expect(model.emptyMessage).toBe("Sign in to Work.");
  });

  it("does not replace an explicit empty snapshot with another source's status", () => {
    expect(
      buildProviderUsageMenuModel({
        provider: "codex",
        providerSnapshot: null,
        usageSummary: { ...emptySummary, providerSnapshot: snapshot({ status: "needs-auth" }) },
      }).emptyMessage,
    ).toBeUndefined();
  });

  it("keeps a pending batch empty rather than showing an unavailable status", () => {
    expect(
      buildProviderUsageMenuModel({
        provider: "codex",
        usageSummary: { ...emptySummary, isLoading: true },
      }),
    ).toMatchObject({ isLoading: true, emptyMessage: undefined, rows: [] });
  });
});
