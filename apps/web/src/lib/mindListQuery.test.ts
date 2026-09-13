import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { MindMemoryId, ProjectId, type MindListResult, type MindMemory } from "@synara/contracts";

import {
  MIND_LIST_QUERY_ROOT,
  mindListQueryKey,
  restoreMindLists,
  snapshotMindLists,
} from "./mindListQuery";

let memoryCounter = 0;
const makeMemory = (overrides: Partial<MindMemory> = {}): MindMemory => {
  memoryCounter += 1;
  return {
    memoryId: MindMemoryId.makeUnsafe(`memory-${memoryCounter}`),
    projectId: ProjectId.makeUnsafe("project-1"),
    text: `fact ${memoryCounter}`,
    type: "semantic",
    weight: 0.6,
    accessCount: 0,
    pinned: false,
    createdAt: "2026-09-12T10:00:00.000Z",
    lastAccessedAt: "2026-09-12T10:00:00.000Z",
    provenance: { kind: "user" },
    ...overrides,
  };
};

const page = (memories: ReadonlyArray<MindMemory>): MindListResult => ({
  memories: [...memories],
  count: memories.length,
  cap: 500,
});

describe("mindListQueryKey", () => {
  it("scopes the cache entry by project and keeps a shared 'all' entry", () => {
    expect(mindListQueryKey(null)).toEqual(["mind", "list", "all"]);
    expect(mindListQueryKey("project-7")).toEqual(["mind", "list", "project-7"]);
  });
});

describe("snapshotMindLists / restoreMindLists", () => {
  it("snapshots and restores every cached list scope, not just the visible one", async () => {
    const client = new QueryClient();
    const globalKey = mindListQueryKey(null);
    const scopedKey = mindListQueryKey("project-7");
    const globalPage = page([makeMemory(), makeMemory()]);
    const scopedPage = page([makeMemory()]);
    client.setQueryData(globalKey, globalPage);
    client.setQueryData(scopedKey, scopedPage);

    const snapshot = await snapshotMindLists(client);
    // The optimistic write would land in both scopes via setQueriesData.
    const removed = globalPage.memories[0];
    if (!removed) throw new Error("expected a memory");
    client.setQueriesData<MindListResult>({ queryKey: MIND_LIST_QUERY_ROOT }, (prev) =>
      prev
        ? { ...prev, memories: prev.memories.filter((m) => m.memoryId !== removed.memoryId) }
        : prev,
    );
    expect(client.getQueryData<MindListResult>(globalKey)?.memories).toHaveLength(1);
    expect(client.getQueryData<MindListResult>(scopedKey)?.memories).toHaveLength(1);

    restoreMindLists(client, snapshot);
    expect(client.getQueryData<MindListResult>(globalKey)).toEqual(globalPage);
    expect(client.getQueryData<MindListResult>(scopedKey)).toEqual(scopedPage);
  });

  it("never fabricates a list entry where none was cached", async () => {
    const client = new QueryClient();
    const globalKey = mindListQueryKey(null);
    const scopedKey = mindListQueryKey("project-empty");
    client.setQueryData(globalKey, page([makeMemory()]));

    const snapshot = await snapshotMindLists(client);
    restoreMindLists(client, snapshot);

    expect(client.getQueryData(scopedKey)).toBeUndefined();
    expect(client.getQueryData(globalKey)).toBeDefined();
  });
});
