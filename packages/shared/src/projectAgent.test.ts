import { ProjectTaskId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  detectProjectTaskDependencyCycle,
  INITIAL_PROJECT_DIGEST_SUMMARY,
  canWriteMemoryDocument,
  isMemoryDocumentPath,
  isMemoryThreadDocumentPath,
  isProjectContextPreviewPath,
  MEMORY_AUTO_DOCUMENT_PATH,
  MEMORY_DOCUMENT_PREFIX,
  memoryThreadDocumentPath,
  normalizeProjectDocumentPath,
  PROJECT_CONTEXT_PREVIEW_DOCUMENTS,
  ProjectAgentPathError,
  sanitizeProjectDigestFocusTitle,
  sanitizeProjectDigestSummary,
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

describe("isMemoryDocumentPath", () => {
  it("recognizes already-normalized memory paths without re-normalizing", () => {
    expect(isMemoryDocumentPath(MEMORY_AUTO_DOCUMENT_PATH)).toBe(true);
    expect(isMemoryDocumentPath("memory/threads/thread-1.md")).toBe(true);
    expect(isMemoryDocumentPath("./memory/note.md")).toBe(false);
    expect(isMemoryDocumentPath("instructions.md")).toBe(false);
    expect(MEMORY_DOCUMENT_PREFIX).toBe("memory/");
    expect(memoryThreadDocumentPath("thread-1")).toBe("memory/threads/thread-1.md");
    expect(isMemoryThreadDocumentPath("memory/threads/thread-1.md")).toBe(true);
    expect(isMemoryThreadDocumentPath("memory/MEMORY.md")).toBe(false);
    expect(
      canWriteMemoryDocument({
        logicalPath: MEMORY_AUTO_DOCUMENT_PATH,
        principalKind: "user",
      }),
    ).toBe(true);
    expect(
      canWriteMemoryDocument({
        logicalPath: MEMORY_AUTO_DOCUMENT_PATH,
        principalKind: "worker",
        principalThreadId: "thread-1",
      }),
    ).toBe(false);
    expect(
      canWriteMemoryDocument({
        logicalPath: memoryThreadDocumentPath("thread-1"),
        principalKind: "worker",
        principalThreadId: "thread-1",
      }),
    ).toBe(true);
    expect(
      canWriteMemoryDocument({
        logicalPath: memoryThreadDocumentPath("thread-2"),
        principalKind: "worker",
        principalThreadId: "thread-1",
      }),
    ).toBe(false);
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
      "docs/project-bot.md",
    ]);
    expect(isProjectContextPreviewPath("instructions.md")).toBe(true);
    expect(isProjectContextPreviewPath("internal/manifest.json")).toBe(false);
    expect(isProjectContextPreviewPath("archived.md")).toBe(false);
    expect(isProjectContextPreviewPath("artifacts/index.md")).toBe(false);
  });
});

describe("sanitizeProjectDigestSummary", () => {
  it("drops leftover start-a-goal copy from Focus", () => {
    expect(
      sanitizeProjectDigestSummary(
        "Coordinator is configured. Start a goal to begin bounded coordination.",
      ),
    ).toBe(INITIAL_PROJECT_DIGEST_SUMMARY);
    expect(sanitizeProjectDigestSummary("Assigned work starts only after a goal is started.")).toBe(
      INITIAL_PROJECT_DIGEST_SUMMARY,
    );
    expect(sanitizeProjectDigestSummary("Sample workers are running.")).toBe(
      "Sample workers are running.",
    );
    expect(
      sanitizeProjectDigestSummary(
        "Coordinator continuation runs are queued. Sample playbook maintenance and Sample local worker both reported failure, while decisions.md was written. No worker completion is confirmed.",
      ),
    ).toBe("Coordinator continuation runs are queued.");
    expect(sanitizeProjectDigestFocusTitle("Sample playbook maintenance reported failed")).toBe(
      "Sample playbook maintenance",
    );
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
