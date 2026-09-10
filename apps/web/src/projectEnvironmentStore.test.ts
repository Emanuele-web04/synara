import { ProjectId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useProjectEnvironmentStore } from "./projectEnvironmentStore";

const PROJECT_A = ProjectId.makeUnsafe("project-a");
const PROJECT_B = ProjectId.makeUnsafe("project-b");

describe("project environment preferences", () => {
  beforeEach(() => {
    useProjectEnvironmentStore.setState({ envModeByProjectId: {} });
  });

  it("remembers each project's latest choice independently", () => {
    const { setProjectEnvMode } = useProjectEnvironmentStore.getState();
    setProjectEnvMode(PROJECT_A, "worktree");
    expect(useProjectEnvironmentStore.getState().envModeByProjectId[PROJECT_B]).toBeUndefined();

    setProjectEnvMode(PROJECT_B, "worktree");
    setProjectEnvMode(PROJECT_A, "local");
    expect(useProjectEnvironmentStore.getState().envModeByProjectId).toEqual({
      [PROJECT_A]: "local",
      [PROJECT_B]: "worktree",
    });
  });

  it("restores both choices from persisted storage", async () => {
    const { setProjectEnvMode } = useProjectEnvironmentStore.getState();
    setProjectEnvMode(PROJECT_A, "local");
    setProjectEnvMode(PROJECT_B, "worktree");
    const { name, storage } = useProjectEnvironmentStore.persist.getOptions();
    const saved = await storage!.getItem(name);

    useProjectEnvironmentStore.setState({ envModeByProjectId: {} });
    await storage!.setItem(name, saved!);
    await useProjectEnvironmentStore.persist.rehydrate();

    expect(useProjectEnvironmentStore.getState().envModeByProjectId).toEqual({
      [PROJECT_A]: "local",
      [PROJECT_B]: "worktree",
    });
  });

  it("ignores invalid stored choices while preserving valid preferences", () => {
    const { merge } = useProjectEnvironmentStore.persist.getOptions();
    expect(
      merge!(
        { envModeByProjectId: { [PROJECT_A]: "worktree", [PROJECT_B]: "invalid" } },
        useProjectEnvironmentStore.getState(),
      ).envModeByProjectId,
    ).toEqual({ [PROJECT_A]: "worktree" });
  });
});
