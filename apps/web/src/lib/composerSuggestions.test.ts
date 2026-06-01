import { ProjectId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { ChatMessage, Project, Thread } from "../types";
import { deriveComposerSuggestions } from "./composerSuggestions";

const PROJECT_ID = ProjectId.makeUnsafe("project-suggestions");
const OTHER_PROJECT_ID = ProjectId.makeUnsafe("project-other");
const ACTIVE_THREAD_ID = ThreadId.makeUnsafe("thread-active");

const MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  model: "gpt-5",
};

function makeProject(partial?: Partial<Project>): Project {
  return {
    id: PROJECT_ID,
    kind: "project",
    name: "Synara",
    remoteName: "synara",
    folderName: "synara",
    localName: null,
    cwd: "/repo/synara",
    defaultModelSelection: null,
    expanded: true,
    scripts: [],
    ...partial,
  };
}

function makeUserMessage(text: string, createdAt: string): ChatMessage {
  return {
    id: `${createdAt}:message` as ChatMessage["id"],
    role: "user",
    text,
    createdAt,
    streaming: false,
  };
}

function makeThread(partial: Partial<Thread> & Pick<Thread, "id" | "title">): Thread {
  const createdAt = partial.createdAt ?? "2026-05-31T10:00:00.000Z";
  return {
    codexThreadId: null,
    projectId: PROJECT_ID,
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [makeUserMessage("Fix the composer suggestion flow", createdAt)],
    proposedPlans: [],
    error: null,
    createdAt,
    updatedAt: createdAt,
    latestTurn: null,
    latestUserMessageAt: createdAt,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...partial,
  };
}

describe("deriveComposerSuggestions", () => {
  it("uses the most recent same-project chats and excludes the active thread", () => {
    const suggestions = deriveComposerSuggestions({
      activeThreadId: ACTIVE_THREAD_ID,
      project: makeProject(),
      threads: [
        makeThread({
          id: ACTIVE_THREAD_ID,
          title: "Current empty draft",
          latestUserMessageAt: "2026-05-31T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-latest"),
          title: "Sidebar suggestions polish",
          latestUserMessageAt: "2026-05-31T11:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-second"),
          title: "Composer resize bug",
          latestUserMessageAt: "2026-05-31T10:30:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-other-project"),
          projectId: OTHER_PROJECT_ID,
          title: "Unrelated project",
          latestUserMessageAt: "2026-05-31T11:30:00.000Z",
        }),
      ],
    });

    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]?.label).toContain("Sidebar suggestions polish");
    expect(suggestions[1]?.label).toContain("Composer resize bug");
    expect(suggestions.map((suggestion) => suggestion.label).join("\n")).not.toContain(
      "Current empty draft",
    );
    expect(suggestions.map((suggestion) => suggestion.label).join("\n")).not.toContain(
      "Unrelated project",
    );
  });

  it("falls back to project-level suggestions when there is no chat history", () => {
    const suggestions = deriveComposerSuggestions({
      activeThreadId: ACTIVE_THREAD_ID,
      project: makeProject({ localName: "Desktop App" }),
      threads: [],
    });

    expect(suggestions.length).toBeGreaterThanOrEqual(3);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    expect(suggestions.every((suggestion) => suggestion.label.includes("Desktop App"))).toBe(true);
  });

  it("keeps inserted prompts compact", () => {
    const suggestions = deriveComposerSuggestions({
      activeThreadId: ACTIVE_THREAD_ID,
      project: makeProject(),
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-long"),
          title:
            "A very long implementation title that should be reduced before it becomes a noisy suggestion row in the composer",
        }),
      ],
    });

    expect(suggestions.length).toBeGreaterThanOrEqual(3);
    for (const suggestion of suggestions) {
      expect(suggestion.prompt.split("\n").length).toBeLessThanOrEqual(6);
    }
  });
});
