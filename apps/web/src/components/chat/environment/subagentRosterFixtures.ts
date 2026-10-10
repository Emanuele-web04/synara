// FILE: subagentRosterFixtures.ts
// Purpose: Shared roster-row fixture for the subagent summary and dock list tests.
// Layer: Test support

import { ThreadId } from "@synara/contracts";

import type { EnvironmentSubagentRosterItem } from "./EnvironmentSubagentsSection.logic";

export function subagentRosterItem(
  label: string,
  overrides: Partial<EnvironmentSubagentRosterItem> = {},
): EnvironmentSubagentRosterItem {
  return {
    kind: "subagent",
    key: `tool-${label}`,
    threadId: ThreadId.makeUnsafe(`subagent:parent:tool-${label}`),
    providerThreadId: `tool-${label}`,
    primaryLabel: label,
    fullLabel: label,
    role: null,
    modelLabel: undefined,
    statusLabel: "Completed",
    statusKind: "completed",
    isActive: false,
    isViewed: false,
    isBackground: false,
    accentColor: "#345fa8",
    startedAt: "2026-10-10T10:00:00.000Z",
    settledAt: "2026-10-10T10:01:00.000Z",
    totalTokens: null,
    toolUses: null,
    durationMs: null,
    lastToolName: null,
    summary: null,
    ...overrides,
  };
}

export function runningSubagentRosterItem(
  label: string,
  overrides: Partial<EnvironmentSubagentRosterItem> = {},
): EnvironmentSubagentRosterItem {
  return subagentRosterItem(label, {
    statusLabel: "Running",
    statusKind: "running",
    isActive: true,
    settledAt: null,
    ...overrides,
  });
}
