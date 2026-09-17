import { ProjectTaskId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  detectProjectTaskDependencyCycle,
  isProjectContextPreviewPath,
  normalizeProjectDocumentPath,
  PROJECT_CONTEXT_PREVIEW_DOCUMENTS,
  ProjectAgentPathError,
  truncateToContextBudget,
} from "./projectAgent";

describe("normalizeProjectDocumentPath", () => {
  it("normalizes relative document paths", () => {
    expect(normalizeProjectDocumentPath("docs/foo.md")).toBe("docs/foo.md");
    expect(normalizeProjectDocumentPath("./notes.md")).toBe("notes.md");
  });

  it("rejects traversal and absolute paths", () => {
    expect(() => normalizeProjectDocumentPath("../secret.md")).toThrow(ProjectAgentPathError);
    expect(() => normalizeProjectDocumentPath("/etc/passwd")).toThrow(ProjectAgentPathError);
    expect(() => normalizeProjectDocumentPath("docs/../../escape.md")).toThrow(
      ProjectAgentPathError,
    );
  });
});

describe("detectProjectTaskDependencyCycle", () => {
  const a = ProjectTaskId.makeUnsafe("task-a");
  const b = ProjectTaskId.makeUnsafe("task-b");
  const c = ProjectTaskId.makeUnsafe("task-c");

  it("accepts acyclic graphs and rejects cycles", () => {
    expect(
      detectProjectTaskDependencyCycle({
        taskId: c,
        dependsOnTaskIds: [b],
        edges: new Map([
          [a, []],
          [b, [a]],
        ]),
      }),
    ).toBe(false);
    expect(
      detectProjectTaskDependencyCycle({
        taskId: a,
        dependsOnTaskIds: [c],
        edges: new Map([
          [b, [a]],
          [c, [b]],
        ]),
      }),
    ).toBe(true);
  });
});

describe("project context preview", () => {
  it("shows only the shared files a person would open", () => {
    expect(PROJECT_CONTEXT_PREVIEW_DOCUMENTS.map((document) => document.logicalPath)).toEqual([
      "instructions.md",
      "notes.md",
      "decisions.md",
    ]);
    expect(isProjectContextPreviewPath("instructions.md")).toBe(true);
    expect(isProjectContextPreviewPath("internal/manifest.json")).toBe(false);
    expect(isProjectContextPreviewPath("archived.md")).toBe(false);
    expect(isProjectContextPreviewPath("artifacts/index.md")).toBe(false);
  });
});

describe("truncateToContextBudget", () => {
  it("caps injected project context", () => {
    const result = truncateToContextBudget(
      [
        { label: "Goal", text: "x".repeat(20) },
        { label: "Notes", text: "y".repeat(40) },
      ],
      40,
    );
    expect(result.characterCount).toBeLessThanOrEqual(40);
    expect(result.truncated).toBe(true);
  });
});
