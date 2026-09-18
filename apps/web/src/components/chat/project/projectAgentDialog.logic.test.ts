import { ProjectId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildProjectAgentConfigureInput,
  defaultProjectAgentName,
  FALLBACK_PROJECT_AGENT_MODEL_SELECTION,
  resolveProjectAgentModelSelection,
  resolveProjectAgentName,
  isProjectAgentRowVisible,
  resolveProjectAgentRowLabel,
  saveProjectAgentDialog,
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

  it("prefers the current coordinator model, then the project default", () => {
    const current = { provider: "grok" as const, model: "grok-4" };
    const fallback = { provider: "codex" as const, model: "gpt-5-codex" };
    expect(
      resolveProjectAgentModelSelection({
        current,
        fallback,
      }),
    ).toEqual(current);
    expect(
      resolveProjectAgentModelSelection({
        current: null,
        fallback,
      }),
    ).toEqual(fallback);
    expect(
      resolveProjectAgentModelSelection({
        current: null,
        fallback: null,
      }),
    ).toEqual(FALLBACK_PROJECT_AGENT_MODEL_SELECTION);
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

  it("clears busy-path errors without leaving the dialog stuck", async () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const modelSelection = { provider: "codex" as const, model: "gpt-5-codex" };
    await expect(
      saveProjectAgentDialog({
        projectId: null,
        coordinatorName: "Bot",
        modelSelection,
        configure: async () => {
          throw new Error("should not run");
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Select a project before setting up the agent.",
    });
    await expect(
      saveProjectAgentDialog({
        projectId,
        coordinatorName: "Bot",
        modelSelection,
        configure: null,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Project agent is unavailable.",
    });
    await expect(
      saveProjectAgentDialog({
        projectId,
        coordinatorName: "Bot",
        modelSelection,
        configure: async () => {
          throw new Error("revision mismatch");
        },
      }),
    ).resolves.toEqual({ ok: false, error: "revision mismatch" });
  });
});
