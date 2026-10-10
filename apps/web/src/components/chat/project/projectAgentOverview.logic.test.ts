// FILE: projectAgentOverview.logic.test.ts
// Purpose: Covers the configured-from-config derivation and overview patching.
// Layer: Client logic unit tests
// Depends on: projectAgentOverview.logic plus contracts fixtures.

import { ProjectAgentConfig, ProjectAgentOverview, ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  projectAgentOverviewConfigured,
  projectAgentOverviewWithConfig,
} from "./projectAgentOverview.logic";

const config = ProjectAgentConfig.makeUnsafe({
  projectId: ProjectId.makeUnsafe("project-1"),
  coordinatorThreadId: ThreadId.makeUnsafe("thread-coordinator"),
  coordinatorName: "alpha",
  coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
  limits: {
    maxConcurrentWorkers: 4,
    maxNewWorkersPerTurn: 2,
    maxWorkerCreationsPerGoal: 12,
    maxAutomaticContinuationsPerGoal: 2,
    maxRepairRoundsPerTask: 2,
  },
  captureEnabled: true,
  enabled: true,
  automationId: null,
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  disabledAt: null,
});

const unconfiguredOverview = ProjectAgentOverview.makeUnsafe({
  projectId: ProjectId.makeUnsafe("project-1"),
  configured: false,
  config: null,
  linkedProjectIds: [],
  goal: null,
  digest: null,
  blockers: [],
  recentOutcomes: [],
  coordinatorStatus: "unconfigured",
});

describe("projectAgentOverviewConfigured", () => {
  it("derives configured from config presence", () => {
    expect(projectAgentOverviewConfigured(null)).toBe(false);
    expect(projectAgentOverviewConfigured(undefined)).toBe(false);
    expect(projectAgentOverviewConfigured(unconfiguredOverview)).toBe(false);
    expect(projectAgentOverviewConfigured({ ...unconfiguredOverview, config })).toBe(true);
  });
});

describe("projectAgentOverviewWithConfig", () => {
  it("patches config and derives configured from its presence", () => {
    const next = projectAgentOverviewWithConfig(unconfiguredOverview, config);
    expect(next.config).toBe(config);
    expect(next.configured).toBe(true);
    expect(projectAgentOverviewConfigured(next)).toBe(true);
    // The stale input is not mutated.
    expect(unconfiguredOverview.configured).toBe(false);
    expect(unconfiguredOverview.config).toBeNull();
  });
});
