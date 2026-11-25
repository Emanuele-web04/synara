import type { ServerProviderStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { AppSettingsSchema } from "~/appSettings";

import { summarizeProviderAccounts } from "./providerAccountSummary";

const defaults = AppSettingsSchema.makeUnsafe({});

function status(
  instanceId: string,
  provider: ServerProviderStatus["provider"],
  patch: Partial<ServerProviderStatus> = {},
): ServerProviderStatus {
  return {
    provider,
    driver: provider,
    instanceId,
    available: true,
    status: "ready",
    authStatus: "authenticated",
    checkedAt: "2026-09-16T21:46:18.000Z",
    ...patch,
  } as ServerProviderStatus;
}

describe("summarizeProviderAccounts", () => {
  it("counts enabled accounts of listed agents that still need a sign-in", () => {
    const settings = {
      ...defaults,
      disabledProviders: ["grok" as const],
      providerInstances: {
        codex_work: { driver: "codex", displayName: "Work", enabled: true },
        codex_off: { driver: "codex", displayName: "Off", enabled: false },
        grok_work: { driver: "grok", displayName: "Grok work", enabled: true },
      },
    };
    const summary = summarizeProviderAccounts(settings, [
      status("codex", "codex"),
      status("codex_work", "codex", { authStatus: "unauthenticated" }),
      status("codex_off", "codex", { authStatus: "unauthenticated" }),
      status("grok_work", "grok", { authStatus: "unauthenticated" }),
    ]);
    expect(summary.needingSignIn).toBe(1);
    const ids = summary.searchAccounts.map((account) => account.instanceId);
    expect(ids).toContain("codex_work");
    expect(ids).toContain("codex_off");
    // A disabled agent is not on the Accounts page, so it is neither badged nor searchable.
    expect(ids).not.toContain("grok_work");
  });
});
