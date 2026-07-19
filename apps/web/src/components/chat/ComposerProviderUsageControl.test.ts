import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveProviderUsageMenuModel,
  type ProviderUsageMenuModel,
} from "~/components/ProviderUsageMenuControl";

import {
  composerProviderUsageContentSizeKey,
  deriveComposerProviderUsageTriggerPresentation,
  resolveComposerProviderUsageSnapshot,
} from "./ComposerProviderUsageControl";

function snapshotModel(
  status: ServerProviderUsageSnapshot["status"],
  detail?: string,
): ProviderUsageMenuModel {
  return deriveProviderUsageMenuModel({
    provider: "codex",
    rateLimits: [],
    usageLines: [],
    notice: undefined,
    isLoading: false,
    snapshotStatus: status ?? null,
    snapshotDetail: detail ?? null,
  });
}

describe("ComposerProviderUsageControl", () => {
  it("uses only the exact selected-provider result and makes missing or failed queries explicit", () => {
    const codexSnapshot: ServerProviderUsageSnapshot = {
      provider: "codex",
      updatedAt: "2026-07-18T12:00:00.000Z",
      limits: [{ window: "Weekly", usedPercent: 40 }],
      usageLines: [],
      source: "test",
      status: "ok",
      planName: "Plus",
    };
    const claudeSnapshot = { ...codexSnapshot, provider: "claudeAgent" as const };

    expect(
      resolveComposerProviderUsageSnapshot({
        provider: "codex",
        snapshots: [claudeSnapshot, codexSnapshot],
        querySettled: true,
        queryFailed: false,
      }),
    ).toBe(codexSnapshot);
    expect(
      resolveComposerProviderUsageSnapshot({
        provider: "codex",
        snapshots: [],
        querySettled: false,
        queryFailed: false,
      }),
    ).toBeUndefined();
    expect(
      resolveComposerProviderUsageSnapshot({
        provider: "codex",
        snapshots: [],
        querySettled: true,
        queryFailed: false,
      }),
    ).toMatchObject({ provider: "codex", status: "error" });
    expect(
      resolveComposerProviderUsageSnapshot({
        provider: "codex",
        snapshots: [codexSnapshot],
        querySettled: true,
        queryFailed: true,
      }),
    ).toMatchObject({ provider: "codex", status: "error" });
  });

  it("presents a primary remaining value and hides only its reset suffix", () => {
    const model = deriveProviderUsageMenuModel({
      provider: "codex",
      rateLimits: [
        {
          provider: "codex",
          updatedAt: "2099-04-08T18:00:00.000Z",
          limits: [
            {
              window: "Weekly",
              usedPercent: 84,
              resetsAt: "2099-04-14T18:00:00.000Z",
              windowDurationMins: 10_080,
            },
          ],
        },
      ],
      usageLines: [],
      notice: undefined,
      isLoading: false,
      snapshotStatus: "ok",
      snapshotDetail: null,
    });

    expect(deriveComposerProviderUsageTriggerPresentation(model, true)).toMatchObject({
      primaryText: "16% left",
      resetText: expect.stringMatching(/^Resets /),
    });
    expect(deriveComposerProviderUsageTriggerPresentation(model, false)).toMatchObject({
      primaryText: "16% left",
      resetText: null,
      accessibleLabel: expect.stringMatching(/Resets /),
    });
    expect(composerProviderUsageContentSizeKey(model)).toMatch(/16% left:Resets /);
  });

  it("keeps not-authenticated, unsupported, error, and no-data states distinct", () => {
    const loadingModel = deriveProviderUsageMenuModel({
      provider: "codex",
      rateLimits: [],
      usageLines: [],
      notice: undefined,
      isLoading: true,
      snapshotStatus: null,
      snapshotDetail: null,
    });

    expect(deriveComposerProviderUsageTriggerPresentation(loadingModel, true)).toHaveProperty(
      "primaryText",
      "Checking…",
    );
    expect(
      deriveComposerProviderUsageTriggerPresentation(snapshotModel("needs-auth"), true),
    ).toHaveProperty("primaryText", "Sign in");
    expect(
      deriveComposerProviderUsageTriggerPresentation(snapshotModel("unsupported"), true),
    ).toHaveProperty("primaryText", "Unsupported");
    expect(
      deriveComposerProviderUsageTriggerPresentation(snapshotModel("error"), true),
    ).toHaveProperty("primaryText", "Unavailable");
    expect(
      deriveComposerProviderUsageTriggerPresentation(snapshotModel(undefined), true),
    ).toHaveProperty("primaryText", "No data");
  });

  it("carries plan metadata through the shared detailed-view model", () => {
    const model = deriveProviderUsageMenuModel({
      provider: "codex",
      rateLimits: [],
      usageLines: [],
      planName: "Plus",
      notice: undefined,
      isLoading: false,
      snapshotStatus: "ok",
      snapshotDetail: null,
    });

    expect(model.planName).toBe("Plus");
  });
});
