// FILE: useAuxiliarySurface.browser.tsx
// Purpose: Verifies the auxiliary dock-surface default for group chats — the
//          Groups panel opens on a group's first visit (new group → coordinator
//          chat), and a deliberate close is remembered across remounts (the
//          reload case) without touching the Environment panel preference.
// Layer: Chat UI browser tests

import "~/index.css";

import { ProjectId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useGroupPanelClosedStore } from "~/groupPanelClosedStore";

import { useAuxiliarySurface } from "./useAuxiliarySurface";

const GROUP_ID = ProjectId.makeUnsafe("group-under-test");
const OTHER_GROUP_ID = ProjectId.makeUnsafe("group-other");
const CLOSED_STORAGE_KEY = "synara:group-panel-closed:v1";

function SurfaceProbe({
  projectId,
  projectPanelEnabled,
  environmentPanelVisible,
}: {
  projectId: ProjectId | null;
  projectPanelEnabled: boolean;
  environmentPanelVisible: boolean;
}) {
  const { auxiliarySurface, chooseAuxiliarySurface, setGroupPanelClosed } = useAuxiliarySurface({
    projectId,
    projectPanelEnabled,
    environmentPanelVisible,
  });
  return (
    <div>
      <output data-testid="surface">{auxiliarySurface ?? "none"}</output>
      <button
        type="button"
        data-testid="close-panel"
        onClick={() => {
          setGroupPanelClosed(true);
          chooseAuxiliarySurface(null);
        }}
      >
        close
      </button>
    </div>
  );
}

describe("useAuxiliarySurface", () => {
  beforeEach(() => {
    localStorage.removeItem(CLOSED_STORAGE_KEY);
    useGroupPanelClosedStore.setState({ closedProjectIds: [] });
  });

  it("opens the Groups panel by default on a new group", async () => {
    await render(
      <SurfaceProbe
        projectId={GROUP_ID}
        projectPanelEnabled={true}
        environmentPanelVisible={false}
      />,
    );
    await expect.element(page.getByTestId("surface")).toHaveTextContent("project");
  });

  it("stays closed across remounts after the user closes it", async () => {
    const first = await render(
      <SurfaceProbe
        projectId={GROUP_ID}
        projectPanelEnabled={true}
        environmentPanelVisible={false}
      />,
    );
    await expect.element(page.getByTestId("surface")).toHaveTextContent("project");

    await page.getByTestId("close-panel").click();
    await expect.element(page.getByTestId("surface")).toHaveTextContent("none");

    // The close is persisted — a reload (store rehydrating from localStorage)
    // keeps the panel closed instead of re-running the first-visit default.
    expect(localStorage.getItem(CLOSED_STORAGE_KEY)).toContain(GROUP_ID);
    await first.unmount();

    await render(
      <SurfaceProbe
        projectId={GROUP_ID}
        projectPanelEnabled={true}
        environmentPanelVisible={false}
      />,
    );
    await expect.element(page.getByTestId("surface")).toHaveTextContent("none");
  });

  it("keeps the environment fallback for non-group chats", async () => {
    await render(
      <SurfaceProbe projectId={null} projectPanelEnabled={false} environmentPanelVisible={true} />,
    );
    await expect.element(page.getByTestId("surface")).toHaveTextContent("environment");
  });

  it("scopes the remembered close to the group it was made in", async () => {
    useGroupPanelClosedStore.setState({ closedProjectIds: [GROUP_ID] });
    await render(
      <SurfaceProbe
        projectId={OTHER_GROUP_ID}
        projectPanelEnabled={true}
        environmentPanelVisible={false}
      />,
    );
    await expect.element(page.getByTestId("surface")).toHaveTextContent("project");
  });
});
