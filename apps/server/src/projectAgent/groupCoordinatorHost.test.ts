import { describe, expect, it } from "vitest";

import {
  coordinatorWelcomeDisplayName,
  coordinatorWelcomeText,
  isGroupCoordinatorHostProject,
} from "./groupCoordinatorHost.ts";

describe("isGroupCoordinatorHostProject", () => {
  const roots = {
    groupsWorkspaceRoot: "/Users/tester/Documents/Synara/Groups",
    studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
  };

  it("accepts a group under the Groups root", () => {
    expect(
      isGroupCoordinatorHostProject({
        kind: "group",
        workspaceRoot: "/Users/tester/Documents/Synara/Groups/alpha",
        ...roots,
      }),
    ).toBe(true);
  });

  it("accepts a legacy studio container under the Studio root", () => {
    expect(
      isGroupCoordinatorHostProject({
        kind: "studio",
        workspaceRoot: "/Users/tester/Documents/Synara/Studio",
        ...roots,
      }),
    ).toBe(true);
  });

  it("rejects an ordinary project", () => {
    expect(
      isGroupCoordinatorHostProject({
        kind: "project",
        workspaceRoot: "/Users/tester/Developer/app",
        ...roots,
      }),
    ).toBe(false);
  });
});

describe("coordinator welcome copy", () => {
  it("uses the profile name, then the home-dir basename, then there", () => {
    expect(
      coordinatorWelcomeDisplayName({
        userDisplayName: " Dilip ",
        homeDir: "/Users/dilipreddy",
      }),
    ).toBe("Dilip");
    expect(
      coordinatorWelcomeDisplayName({
        userDisplayName: "  ",
        homeDir: "/Users/dilipreddy",
      }),
    ).toBe("dilipreddy");
    expect(coordinatorWelcomeDisplayName({ homeDir: "/" })).toBe("there");
  });

  it("substitutes the name into the greeting", () => {
    expect(coordinatorWelcomeText("Dilip")).toContain("Hi Dilip, welcome to your new group.");
  });
});
