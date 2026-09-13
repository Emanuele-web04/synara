import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ProjectId, type MindProfile } from "@synara/contracts";

import { rollbackOptimisticProfile } from "./mindProfileQuery";

const key = ["mind", "profile", "project-1"] as const;

const profile = (text: string): MindProfile => ({
  projectId: ProjectId.makeUnsafe("project-1"),
  text,
  optedIn: true,
  updatedAt: "2026-09-13T00:00:00.000Z",
});

describe("rollbackOptimisticProfile", () => {
  it("removes a fabricated profile when a rejected first save has no snapshot", () => {
    const client = new QueryClient();
    // The optimistic write landed with no prior cache entry — this is the
    // rejected-first-save case the rollback guard used to skip.
    client.setQueryData(key, profile("unsaved draft"));

    rollbackOptimisticProfile(client, key, undefined);

    expect(client.getQueryData(key)).toBeUndefined();
  });

  it("restores the snapshot when the query had data before the optimistic write", () => {
    const client = new QueryClient();
    const saved = profile("saved profile");
    client.setQueryData(key, saved);
    client.setQueryData(key, profile("optimistic draft"));

    rollbackOptimisticProfile(client, key, saved);

    expect(client.getQueryData(key)).toEqual(saved);
  });

  it("restores a cached null — 'server says no profile' is real data", () => {
    const client = new QueryClient();
    client.setQueryData(key, null);
    client.setQueryData(key, profile("optimistic draft"));

    rollbackOptimisticProfile(client, key, null);

    expect(client.getQueryData(key)).toBeNull();
  });
});
