// FILE: chatProjects.test.ts
// Purpose: Verifies home chat-container project recognition across new and legacy roots.

import { describe, expect, it } from "vitest";

import { isHomeChatContainerProject } from "./chatProjects";

describe("isHomeChatContainerProject", () => {
  it("matches the managed Documents/Synara general-chat workspace", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Documents/Synara",
          kind: "chat",
          name: "Home",
          remoteName: "Home",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(true);
  });

  it("keeps recognizing the legacy home-directory chat container during migration", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester",
          kind: "chat",
          name: "Home",
          remoteName: "Home",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(true);
  });

  it("does not classify ordinary projects under Documents/Synara as home chat containers", () => {
    expect(
      isHomeChatContainerProject(
        {
          cwd: "/Users/tester/Documents/Synara",
          kind: "project",
          name: "Synara",
          remoteName: "Synara",
        },
        {
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Synara",
        },
      ),
    ).toBe(false);
  });
});
