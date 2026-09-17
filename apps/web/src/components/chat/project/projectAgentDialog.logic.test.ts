import { ProjectId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildProjectAgentConfigureInput,
  defaultProjectAgentName,
  resolveProjectAgentName,
} from "./projectAgentDialog.logic";

describe("project agent dialog defaults", () => {
  it("names a new agent after the project", () => {
    expect(defaultProjectAgentName("synara")).toBe("synara Coordinator");
    expect(defaultProjectAgentName("  ")).toBe("Project Coordinator");
  });

  it("falls back to the default name when the field is blank", () => {
    expect(
      resolveProjectAgentName({
        value: "   ",
        fallbackName: "synara Coordinator",
      }),
    ).toBe("synara Coordinator");
    expect(
      resolveProjectAgentName({
        value: "Studio Agent",
        fallbackName: "synara Coordinator",
      }),
    ).toBe("Studio Agent");
  });

  it("sends expectedRevision only when editing", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const modelSelection = { provider: "codex" as const, model: "gpt-5-codex" };
    const created = buildProjectAgentConfigureInput({
      projectId,
      coordinatorName: "synara Coordinator",
      modelSelection,
    });
    expect(created.expectedRevision).toBeUndefined();
    expect(created.coordinatorName).toBe("synara Coordinator");

    const edited = buildProjectAgentConfigureInput({
      projectId,
      coordinatorName: "Studio Agent",
      modelSelection,
      expectedRevision: 4,
    });
    expect(edited.expectedRevision).toBe(4);
    expect(edited.coordinatorName).toBe("Studio Agent");
  });
});
