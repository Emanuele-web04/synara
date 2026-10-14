import { ProjectId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { pinId, prunePinnedIds, unpinId } from "./pinning.logic";

describe("pinned project agent ids", () => {
  it("pins and unpins a project agent under its folder", () => {
    const projectId = "project-1" as ProjectId;
    const pinned = pinId([], projectId);
    expect(pinned.pinnedIds).toEqual([projectId]);
    expect(unpinId(pinned.pinnedIds, projectId).pinnedIds).toEqual([]);
  });

  it("prunes pins for projects that no longer exist", () => {
    const pinned = ["project-1", "project-2"] as ProjectId[];
    expect(prunePinnedIds(pinned, ["project-2" as ProjectId])).toEqual(["project-2"]);
  });
});
