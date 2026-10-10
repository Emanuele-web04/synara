// FILE: EnvironmentProjectInstructionsSection.browser.tsx
// Purpose: Browser-level regression tests for project instructions autosave behavior.
// Layer: Vitest browser tests

import "../../../index.css";

import { ProjectId } from "@synara/contracts";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EnvironmentProjectInstructionsSection } from "./EnvironmentProjectInstructionsSection";

const PROJECT_A = ProjectId.makeUnsafe("project-instructions-a");
const PROJECT_B = ProjectId.makeUnsafe("project-instructions-b");

describe("EnvironmentProjectInstructionsSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("flushes pending edits to the original project before switching projects", async () => {
    const onInstructionsChange = vi.fn();

    function ProjectSwitchHarness() {
      const [projectId, setProjectId] = useState<ProjectId>(PROJECT_A);
      return (
        <>
          <button type="button" onClick={() => setProjectId(PROJECT_B)}>
            Switch project
          </button>
          <EnvironmentProjectInstructionsSection
            projectId={projectId}
            instructions={
              projectId === PROJECT_A ? "Saved instructions for A" : "Saved instructions for B"
            }
            threadNotes=""
            canCopyToThreadNotes
            onInstructionsChange={onInstructionsChange}
            onCopyToThreadNotes={vi.fn()}
          />
        </>
      );
    }

    await render(<ProjectSwitchHarness />);

    await page.getByPlaceholder("Architecture notes, conventions, repo links").fill("Draft for A");
    await page.getByRole("button", { name: "Switch project" }).click();

    expect(onInstructionsChange).toHaveBeenCalledWith(PROJECT_A, "Draft for A");
    expect(onInstructionsChange).not.toHaveBeenCalledWith(PROJECT_B, "Draft for A");
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Saved instructions for B",
    );
  });
});
