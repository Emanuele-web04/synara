import { ProjectId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useRailShellStore } from "./railShellStore";

const PROJECT_A = ProjectId.makeUnsafe("project-a");
const PROJECT_B = ProjectId.makeUnsafe("project-b");

describe("railShellStore", () => {
  beforeEach(() => {
    useRailShellStore.setState({
      activeItem: "home",
      panelView: "home",
      spacesProjectId: null,
      reconciledRouteKey: null,
    });
  });

  it("selectPanelItem sets both the active item and the panel view", () => {
    useRailShellStore.getState().selectPanelItem("spaces");
    const state = useRailShellStore.getState();
    expect(state.activeItem).toBe("spaces");
    expect(state.panelView).toBe("spaces");
  });

  it("reconcile clears a drill-in project that no longer exists", () => {
    useRailShellStore.getState().openSpacesProject(PROJECT_A);
    const { reconcile } = useRailShellStore.getState();
    reconcile({ pathname: "/", onStudioSurface: false, projectIds: null });
    expect(useRailShellStore.getState().spacesProjectId).toBe(PROJECT_A);
    reconcile({ pathname: "/", onStudioSurface: false, projectIds: new Set([PROJECT_B]) });
    expect(useRailShellStore.getState().spacesProjectId).toBeNull();
  });

  it("reconcile keeps a clicked panel item until the pathname changes", () => {
    const { reconcile, selectPanelItem } = useRailShellStore.getState();
    const projectIds = new Set([PROJECT_A]);
    reconcile({ pathname: "/pull-requests", onStudioSurface: false, projectIds: null });
    expect(useRailShellStore.getState().activeItem).toBe("pullRequests");
    selectPanelItem("spaces");
    reconcile({ pathname: "/pull-requests", onStudioSurface: false, projectIds });
    expect(useRailShellStore.getState().activeItem).toBe("spaces");
    reconcile({ pathname: "/kanban", onStudioSurface: false, projectIds });
    expect(useRailShellStore.getState().activeItem).toBe("kanban");
  });
});
