import { describe, expect, it } from "vitest";

import {
  defaultProjectAgentName,
  isProjectAgentRowVisible,
  resolveProjectAgentRowLabel,
} from "./projectAgentDialog.logic";

describe("project agent dialog defaults", () => {
  it("names a new agent after the project", () => {
    expect(defaultProjectAgentName("synara")).toBe("synara Coordinator");
    expect(defaultProjectAgentName("  ")).toBe("Project Coordinator");
  });

  it("labels the nested sidebar row as the agent or a setup action", () => {
    expect(
      resolveProjectAgentRowLabel({
        configured: true,
        coordinatorName: "Master Bot",
      }),
    ).toBe("Master Bot");
    expect(
      resolveProjectAgentRowLabel({
        configured: false,
        coordinatorName: "Master Bot",
      }),
    ).toBe("Set up project agent");
  });

  it("keeps a pinned project agent visible when the folder is collapsed", () => {
    expect(isProjectAgentRowVisible({ projectExpanded: false, pinned: true })).toBe(true);
    expect(isProjectAgentRowVisible({ projectExpanded: true, pinned: false })).toBe(true);
    expect(isProjectAgentRowVisible({ projectExpanded: false, pinned: false })).toBe(false);
  });
});
