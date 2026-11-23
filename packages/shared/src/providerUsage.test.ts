// FILE: providerUsage.test.ts
// Purpose: Locks usage-provider metadata and the settings-panel visibility rule
// that hides unsigned providers once any connected snapshot exists.

import { describe, expect, it } from "vitest";

import type { ServerProviderUsageSnapshot } from "@synara/contracts";

import { selectVisibleProviderUsageSnapshots } from "./providerUsage";

function snapshot(
  provider: ServerProviderUsageSnapshot["provider"],
  status: NonNullable<ServerProviderUsageSnapshot["status"]>,
): ServerProviderUsageSnapshot {
  return {
    provider,
    updatedAt: "2026-08-19T00:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "test",
    status,
  };
}

describe("provider usage metadata", () => {
  it("keeps every unsigned card visible when nothing is connected", () => {
    const snapshots = [
      snapshot("codex", "needs-auth"),
      snapshot("grok", "needs-auth"),
      snapshot("antigravity", "needs-auth"),
    ];
    expect(selectVisibleProviderUsageSnapshots(snapshots).map((item) => item.provider)).toEqual([
      "codex",
      "antigravity",
      "grok",
    ]);
  });

  it("hides unsigned providers once any connected snapshot exists", () => {
    const snapshots = [
      snapshot("codex", "ok"),
      snapshot("claudeAgent", "needs-auth"),
      snapshot("grok", "ok"),
      snapshot("antigravity", "needs-auth"),
    ];
    expect(selectVisibleProviderUsageSnapshots(snapshots).map((item) => item.provider)).toEqual([
      "codex",
      "grok",
    ]);
  });

  it("keeps every account in provider order and preserves account order within a provider", () => {
    const codexWork = { ...snapshot("codex", "ok"), instanceId: "codex_work" };
    const codexDefault = { ...snapshot("codex", "ok"), instanceId: "codex" };
    const claudePersonal = {
      ...snapshot("claudeAgent", "ok"),
      instanceId: "claude_personal",
    };
    const claudeWork = { ...snapshot("claudeAgent", "ok"), instanceId: "claude_work" };
    const grok = snapshot("grok", "ok");

    expect(
      selectVisibleProviderUsageSnapshots([
        grok,
        claudePersonal,
        codexWork,
        claudeWork,
        codexDefault,
      ]),
    ).toEqual([codexWork, codexDefault, claudePersonal, claudeWork, grok]);
  });

  it("filters unsigned accounts without hiding connected accounts of the same provider", () => {
    const unsignedCodex = { ...snapshot("codex", "needs-auth"), instanceId: "codex" };
    const codexWork = { ...snapshot("codex", "ok"), instanceId: "codex_work" };
    const claudeWork = { ...snapshot("claudeAgent", "error"), instanceId: "claude_work" };
    const unsignedClaude = {
      ...snapshot("claudeAgent", "needs-auth"),
      instanceId: "claude_personal",
    };

    expect(
      selectVisibleProviderUsageSnapshots([codexWork, unsignedCodex, claudeWork, unsignedClaude]),
    ).toEqual([codexWork, claudeWork]);
  });

  it("keeps all unsigned accounts visible when no account is connected", () => {
    const codexDefault = { ...snapshot("codex", "needs-auth"), instanceId: "codex" };
    const codexWork = { ...snapshot("codex", "needs-auth"), instanceId: "codex_work" };

    expect(selectVisibleProviderUsageSnapshots([codexDefault, codexWork])).toEqual([
      codexDefault,
      codexWork,
    ]);
  });

  it("treats a live fetch error as connected so unsigned cards still hide", () => {
    const snapshots = [
      snapshot("codex", "error"),
      snapshot("claudeAgent", "needs-auth"),
      snapshot("opencode", "needs-auth"),
    ];
    expect(selectVisibleProviderUsageSnapshots(snapshots).map((item) => item.provider)).toEqual([
      "codex",
    ]);
  });
});
