import { ProjectId, SpaceId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useSpacesUiStore } from "../spacesUiStore";
import { useRouteSpaceSync } from "./useRouteSpaceSync";

const routeProjectId = ProjectId.makeUnsafe("project-void");
const selectedSpaceId = SpaceId.makeUnsafe("space-work");

function RouteSpaceSyncFixture() {
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const setActiveSpaceId = useSpacesUiStore((state) => state.setActiveSpaceId);
  useRouteSpaceSync({
    routeProjectId,
    routeSpaceId: null,
    routeThreadId: null,
    isOnKanban: true,
  });

  return (
    <button type="button" onClick={() => setActiveSpaceId(selectedSpaceId)}>
      {activeSpaceId ?? "void"}
    </button>
  );
}

describe("route Space synchronization", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    useSpacesUiStore.setState({
      activeSpaceId: null,
      lastThreadIdBySpace: {},
      lastProjectIdBySpace: {},
    });
  });

  it("does not let an unchanged route revert a manual Space selection", async () => {
    const screen = await render(<RouteSpaceSyncFixture />);

    try {
      await page.getByRole("button").click();
      // Commit the unchanged route inputs after the store update so its effect has run.
      await screen.rerender(<RouteSpaceSyncFixture />);
      await expect.element(page.getByRole("button")).toHaveTextContent(selectedSpaceId);
    } finally {
      await screen.unmount();
    }
  });
});
