import { describe, expect, it } from "vitest";

import { ProjectId } from "@synara/contracts";

import { isAllowedGroupCoordinatorCreateTarget } from "../projectAgent/groupCreateAllowlist.ts";

describe("group coordinator create allowlist", () => {
  const group = ProjectId.makeUnsafe("group-1");
  const linked = ProjectId.makeUnsafe("repo-1");
  const other = ProjectId.makeUnsafe("repo-2");

  it("allows the group itself and linked repositories", () => {
    expect(
      isAllowedGroupCoordinatorCreateTarget({
        targetProjectId: group,
        groupProjectId: group,
        linkedProjectIds: [linked],
      }),
    ).toBe(true);
    expect(
      isAllowedGroupCoordinatorCreateTarget({
        targetProjectId: linked,
        groupProjectId: group,
        linkedProjectIds: [linked],
      }),
    ).toBe(true);
  });

  it("rejects an unlinked project", () => {
    expect(
      isAllowedGroupCoordinatorCreateTarget({
        targetProjectId: other,
        groupProjectId: group,
        linkedProjectIds: [linked],
      }),
    ).toBe(false);
  });
});
