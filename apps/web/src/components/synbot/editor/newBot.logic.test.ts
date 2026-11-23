import { ProjectId, type ModelSelection } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { blankBotEditorForm } from "./botEditor.logic";
import {
  chooseAllProjects,
  newBotEngineProvider,
  newBotStepIssue,
  newBotSteps,
  projectsSummary,
  toggleBotProject,
} from "./newBot.logic";

describe("newBotEngineProvider", () => {
  const base = {
    preferred: "codex" as const,
    hiddenProviders: [],
    providerOrder: [],
    hasDefaultModel: (provider: string) => provider !== "pi",
  };

  it("keeps the preferred engine while it can run or its status is still unknown", () => {
    expect(newBotEngineProvider({ ...base, statuses: [] })).toBe("codex");
    expect(
      newBotEngineProvider({
        ...base,
        statuses: [
          { provider: "codex", available: true },
          { provider: "grok", available: true },
        ],
      }),
    ).toBe("codex");
  });

  it("moves to the first available engine in the user's order when the preferred one cannot run", () => {
    expect(
      newBotEngineProvider({
        ...base,
        providerOrder: ["grok", "cursor"],
        statuses: [
          { provider: "codex", available: false },
          { provider: "pi", available: true },
          { provider: "cursor", available: true },
          { provider: "grok", available: true },
        ],
      }),
    ).toBe("grok");
  });

  it("skips hidden engines, and keeps the preferred one when nothing else can run", () => {
    expect(
      newBotEngineProvider({
        ...base,
        hiddenProviders: ["codex", "grok"],
        statuses: [
          { provider: "codex", available: true },
          { provider: "grok", available: true },
          { provider: "cursor", available: true },
        ],
      }),
    ).toBe("cursor");
    expect(
      newBotEngineProvider({
        ...base,
        statuses: [
          { provider: "codex", available: false },
          { provider: "grok", available: false },
        ],
      }),
    ).toBe("codex");
  });
});

const engine = { provider: "codex", model: "gpt-5-codex" } as ModelSelection;
const blank = blankBotEditorForm({ modelSelection: engine, mascotIndex: 0 });
const web = ProjectId.makeUnsafe("web");
const api = ProjectId.makeUnsafe("api");

describe("newBotSteps", () => {
  it("asks for the computer only when there is more than one", () => {
    expect(newBotSteps(true)).toEqual(["computer", "bot", "start"]);
    expect(newBotSteps(false)).toEqual(["bot", "start"]);
  });
});

describe("newBotStepIssue", () => {
  it("lets the computer step through and holds the bot step until it has a name", () => {
    expect(newBotStepIssue("computer", blank)).toBeNull();
    expect(newBotStepIssue("bot", blank)).toBe("name-required");
    expect(newBotStepIssue("bot", { ...blank, name: "Web" })).toBeNull();
  });

  it("holds the bot step on the name only, and the last step on chosen projects too", () => {
    const noProjects = { ...blank, name: "Web", scopeMode: "chosen" as const, projectIds: [] };
    expect(newBotStepIssue("bot", noProjects)).toBeNull();
    expect(newBotStepIssue("start", noProjects)).toBe("projects-required");
    expect(newBotStepIssue("start", { ...noProjects, projectIds: [web] })).toBeNull();
  });
});

describe("projects", () => {
  const projects = [{ id: "api" }, { id: "web" }, { id: "docs" }];

  it("summarizes every project or the chosen ones in list order", () => {
    expect(projectsSummary(blank, projects)).toEqual({ all: true });
    expect(projectsSummary({ scopeMode: "chosen", projectIds: [web, api] }, projects)).toEqual({
      all: false,
      chosen: [{ id: "api" }, { id: "web" }],
    });
  });

  it("starts in the picked project alone when it started in every project", () => {
    expect(toggleBotProject(blank, web)).toEqual({ scopeMode: "chosen", projectIds: [web] });
  });

  it("adds and removes chosen projects", () => {
    const one = { scopeMode: "chosen" as const, projectIds: [web] };
    expect(toggleBotProject(one, api)).toEqual({ scopeMode: "chosen", projectIds: [web, api] });
    expect(toggleBotProject(one, web)).toEqual({ scopeMode: "chosen", projectIds: [] });
  });

  it("goes back to every project", () => {
    expect(chooseAllProjects()).toEqual({ scopeMode: "all", projectIds: [] });
  });
});
