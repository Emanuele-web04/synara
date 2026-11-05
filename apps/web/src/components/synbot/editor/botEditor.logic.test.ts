import { ProjectId, ThreadId, type Bot, type ModelSelection } from "@synara/contracts";
import { BOT_TEMPLATES } from "@synara/shared/bots";
import { describe, expect, it } from "vitest";

import {
  applyBotTemplate,
  availableBotTemplates,
  blankBotEditorForm,
  botCreateInput,
  botEditorFormFromBot,
  botEditorIssue,
  botScopeFromForm,
  botUpdateInput,
  crewCreateInputs,
  findBotTemplate,
  isBotConflictError,
  missingCrewTemplates,
  rebaseBotEditorForm,
} from "./botEditor.logic";

const luna: ModelSelection = { provider: "codex", model: "gpt-6-luna" };
const codex: ModelSelection = { provider: "codex", model: "gpt-5-codex" };
const projectA = ProjectId.makeUnsafe("project-a");
const projectB = ProjectId.makeUnsafe("project-b");

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: ProjectId.makeUnsafe("bot-1"),
    kind: "bot",
    name: "Frontend",
    role: "Interfaces",
    mascot: { shape: "clover", color: "#2fb36b" },
    instructions: "Match the tokens.",
    scope: { projects: "all", paths: ["apps/web/**"] },
    modelSelection: luna,
    autonomy: "auto",
    pinnedSkills: [],
    pinned: false,
    threadId: ThreadId.makeUnsafe("thread-1"),
    status: "idle",
    revision: 4,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("templates", () => {
  it("finds templates by name, ignoring case", () => {
    expect(findBotTemplate("frontend")?.name).toBe("Frontend");
    expect(findBotTemplate("crew")).toBeNull();
    expect(findBotTemplate(undefined)).toBeNull();
  });

  it("offers only templates whose name is free", () => {
    const names = availableBotTemplates([{ name: "qa" }]).map((template) => template.name);
    expect(names).not.toContain("QA");
    expect(names).toContain("Docs");
  });

  it("lists the missing crew members in crew order", () => {
    expect(missingCrewTemplates([{ name: "Backend" }]).map((template) => template.name)).toEqual([
      "Frontend",
      "QA",
    ]);
    expect(
      missingCrewTemplates([{ name: "Frontend" }, { name: "Backend" }, { name: "QA" }]),
    ).toEqual([]);
  });

  it("fills identity from a template and keeps scope and engine", () => {
    const template = BOT_TEMPLATES.find((entry) => entry.name === "Docs")!;
    const form = applyBotTemplate(
      { ...blankBotEditorForm({ modelSelection: codex, mascotIndex: 0 }), paths: ["docs/**"] },
      template,
    );
    expect(form).toMatchObject({
      name: "Docs",
      role: template.role,
      mascot: template.mascot,
      instructions: template.instructions,
      paths: ["docs/**"],
      modelSelection: codex,
    });
  });
});

describe("validation and scope", () => {
  it("needs a name and, for chosen projects, at least one project", () => {
    const blank = blankBotEditorForm({ modelSelection: luna, mascotIndex: 2 });
    expect(blank.mascot.shape).not.toBe("synara");
    expect(botEditorIssue(blank)).toBe("name-required");
    expect(botEditorIssue({ ...blank, name: "  Ops ", scopeMode: "chosen" })).toBe(
      "projects-required",
    );
    expect(
      botEditorIssue({ ...blank, name: "Ops", scopeMode: "chosen", projectIds: [projectA] }),
    ).toBe(null);
  });

  it("drops blank and duplicate path rows and keeps chosen projects unique", () => {
    const form = {
      ...blankBotEditorForm({ modelSelection: luna, mascotIndex: 0 }),
      scopeMode: "chosen" as const,
      projectIds: [projectA, projectA, projectB],
      paths: [" apps/web/** ", "", "apps/web/**", "packages/ui/**"],
    };
    expect(botScopeFromForm(form)).toEqual({
      projects: [projectA, projectB],
      paths: ["apps/web/**", "packages/ui/**"],
    });
    expect(botScopeFromForm({ ...form, scopeMode: "all" }).projects).toBe("all");
  });
});

describe("create", () => {
  it("trims text and omits empty optional fields", () => {
    const input = botCreateInput(
      {
        ...blankBotEditorForm({ modelSelection: luna, mascotIndex: 0 }),
        name: " Ops ",
        role: " CI ",
      },
      "request-1",
    );
    expect(input).toMatchObject({
      requestId: "request-1",
      name: "Ops",
      role: "CI",
      autonomy: "auto",
    });
    expect(input).not.toHaveProperty("instructions");
    expect(input).not.toHaveProperty("taskModelSelection");
  });

  it("creates the missing crew from templates with stable request ids", () => {
    const inputs = crewCreateInputs({
      bots: [{ name: "QA" }],
      modelSelection: luna,
      requestId: "crew-1",
    });
    expect(inputs.map((input) => [input.name, input.requestId])).toEqual([
      ["Frontend", "crew-1:frontend"],
      ["Backend", "crew-1:backend"],
    ]);
    expect(inputs.every((input) => input.scope.projects === "all")).toBe(true);
    expect(inputs[0]!.modelSelection).toEqual(luna);
  });
});

describe("update", () => {
  it("returns null when nothing changed", () => {
    const current = bot();
    expect(botUpdateInput(current, botEditorFormFromBot(current))).toBeNull();
  });

  it("sends only the changed fields with the revision the editor opened", () => {
    const current = bot();
    const form = {
      ...botEditorFormFromBot(current),
      role: "Web UI ",
      paths: ["apps/web/**", ""],
      autonomy: "ask" as const,
    };
    expect(botUpdateInput(current, form)).toEqual({
      id: current.id,
      expectedRevision: 4,
      role: "Web UI",
      autonomy: "ask",
    });
  });

  it("clears the task engine with null and sets it with a selection", () => {
    const withTask = bot({ taskModelSelection: codex });
    expect(
      botUpdateInput(withTask, { ...botEditorFormFromBot(withTask), taskModelSelection: null }),
    ).toMatchObject({ taskModelSelection: null });
    const plain = bot();
    expect(
      botUpdateInput(plain, { ...botEditorFormFromBot(plain), taskModelSelection: codex }),
    ).toMatchObject({ taskModelSelection: codex });
  });

  it("keeps SynBot's name, role, scope, shape and tile fixed", () => {
    const main = bot({
      kind: "main",
      name: "SynBot",
      mascot: { shape: "synara", color: "#1a80fa" },
    });
    const form = {
      ...botEditorFormFromBot(main),
      name: "Other",
      role: "Changed",
      scopeMode: "chosen" as const,
      projectIds: [projectA],
      mascot: { shape: "star" as const, color: "#e5484d" },
      pinned: true,
    };
    expect(botUpdateInput(main, form)).toEqual({
      id: main.id,
      expectedRevision: 4,
      mascot: { shape: "synara", color: "#e5484d" },
    });
  });
});

describe("conflicts", () => {
  it("recognizes the server's conflict message", () => {
    expect(isBotConflictError("Failed to update the bot: The bot changed. Reload and retry.")).toBe(
      true,
    );
    expect(isBotConflictError("Bot was not found.")).toBe(false);
  });

  it("rebases untouched fields onto the latest bot and keeps the user's edits", () => {
    const opened = botEditorFormFromBot(bot());
    const latest = botEditorFormFromBot(bot({ role: "Theirs", modelSelection: codex }));
    const edited = { ...opened, role: "Mine", instructions: "New rules." };
    expect(rebaseBotEditorForm(edited, opened, latest)).toEqual({
      ...opened,
      role: "Mine",
      instructions: "New rules.",
      modelSelection: codex,
    });
  });
});
