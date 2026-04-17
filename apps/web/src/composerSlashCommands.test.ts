import { describe, expect, it } from "vitest";

import {
  buildReviewPrompt,
  buildSubagentsPrompt,
  canOfferForkSlashCommand,
  canOfferReviewSlashCommand,
  filterComposerSlashCommands,
  getAvailableComposerSlashCommands,
  hasProviderNativeSlashCommand,
  isBuiltInComposerSlashCommand,
  parseComposerSlashInvocation,
  parseComposerSlashInvocationForCommands,
  parseFastSlashCommandAction,
  parseForkSlashCommandArgs,
  shouldHideProviderNativeCommandFromComposerMenu,
} from "./composerSlashCommands";

describe("composerSlashCommands", () => {
  it("recognizes built-in slash commands", () => {
    expect(isBuiltInComposerSlashCommand("review")).toBe(true);
    expect(isBuiltInComposerSlashCommand("fast")).toBe(true);
    expect(isBuiltInComposerSlashCommand("unknown")).toBe(false);
  });

  it("filters slash commands by query", () => {
    expect(filterComposerSlashCommands("rev").map((entry) => entry.command)).toEqual(["review"]);
    expect(filterComposerSlashCommands("fast").map((entry) => entry.command)).toEqual(["fast"]);
  });

  it("parses slash invocations with optional arguments", () => {
    expect(parseComposerSlashInvocation("/review current diff")).toEqual({
      command: "review",
      args: "current diff",
    });
    expect(parseComposerSlashInvocation("/fast")).toEqual({
      command: "fast",
      args: "",
    });
    expect(parseComposerSlashInvocation("review")).toBeNull();
  });

  it("does not parse app slash commands that are shadowed by provider-native commands", () => {
    expect(parseComposerSlashInvocationForCommands("/fast", ["clear", "model"])).toBeNull();
    expect(parseComposerSlashInvocationForCommands("/clear", ["clear", "model"])).toEqual({
      command: "clear",
      args: "",
    });
  });

  it("parses /fast actions", () => {
    expect(parseFastSlashCommandAction("/fast")).toBe("toggle");
    expect(parseFastSlashCommandAction("/fast on")).toBe("on");
    expect(parseFastSlashCommandAction("/fast off")).toBe("off");
    expect(parseFastSlashCommandAction("/fast status")).toBe("status");
    expect(parseFastSlashCommandAction("/fast maybe")).toBe("invalid");
    expect(parseFastSlashCommandAction("/review")).toBeNull();
  });

  it("parses /fork target shorthand only", () => {
    expect(parseForkSlashCommandArgs("")).toEqual({
      target: null,
      invalid: false,
    });
    expect(parseForkSlashCommandArgs("local")).toEqual({
      target: "local",
      invalid: false,
    });
    expect(parseForkSlashCommandArgs("  worktree  ")).toEqual({
      target: "worktree",
      invalid: false,
    });
    expect(parseForkSlashCommandArgs("follow up on the bug")).toEqual({
      target: null,
      invalid: true,
    });
    expect(parseForkSlashCommandArgs("local continue here")).toEqual({
      target: null,
      invalid: true,
    });
  });

  it("only offers /fork for an otherwise empty default composer", () => {
    expect(
      canOfferForkSlashCommand({
        prompt: "",
        imageCount: 0,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
        interactionMode: "default",
      }),
    ).toBe(true);

    expect(
      canOfferForkSlashCommand({
        prompt: "hello",
        imageCount: 0,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
        interactionMode: "default",
      }),
    ).toBe(false);

    expect(
      canOfferForkSlashCommand({
        prompt: "",
        imageCount: 0,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
        interactionMode: "plan",
      }),
    ).toBe(false);
  });

  it("only offers /review for an otherwise empty composer", () => {
    expect(
      canOfferReviewSlashCommand({
        prompt: "",
        imageCount: 0,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
      }),
    ).toBe(true);

    expect(
      canOfferReviewSlashCommand({
        prompt: "",
        imageCount: 1,
        terminalContextCount: 0,
        selectedSkillCount: 0,
        selectedMentionCount: 0,
      }),
    ).toBe(false);
  });

  it("builds slash-command canned prompts", () => {
    expect(buildSubagentsPrompt("")).toContain("Run subagents");
    expect(buildSubagentsPrompt("Already there")).toContain("Already there\n\nRun subagents");
    expect(buildReviewPrompt({ target: "changes" })).toContain("uncommitted changes");
    expect(buildReviewPrompt({ target: "base-branch" })).toContain("base branch");
  });

  it("filters app slash commands when a provider exposes the same command natively", () => {
    const availableCommands = getAvailableComposerSlashCommands({
      provider: "codex",
      supportsFastSlashCommand: true,
      canOfferCompactCommand: true,
      canOfferReviewCommand: true,
      canOfferForkCommand: true,
      providerNativeCommandNames: ["fast", "/model", "status"],
    });

    expect(availableCommands).not.toContain("fast");
    expect(availableCommands).not.toContain("model");
    expect(availableCommands).not.toContain("status");
    expect(hasProviderNativeSlashCommand("codex", ["/fast", "model"], "fast")).toBe(true);
    expect(hasProviderNativeSlashCommand("codex", ["/fast", "model"], "/model")).toBe(true);
  });

  it("keeps app-level /review available for codex even when native review exists", () => {
    const availableCommands = getAvailableComposerSlashCommands({
      provider: "codex",
      supportsFastSlashCommand: true,
      canOfferCompactCommand: true,
      canOfferReviewCommand: true,
      canOfferForkCommand: true,
      providerNativeCommandNames: ["review"],
    });

    expect(availableCommands).toContain("review");
    expect(shouldHideProviderNativeCommandFromComposerMenu("codex", "review")).toBe(true);
    expect(shouldHideProviderNativeCommandFromComposerMenu("codex", "status")).toBe(false);
  });

  it("never exposes app-level slash commands for claude", () => {
    expect(
      getAvailableComposerSlashCommands({
        provider: "claudeAgent",
        supportsFastSlashCommand: true,
        canOfferCompactCommand: true,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
      }),
    ).toEqual([]);
  });

  it("only offers /compact when Codex compaction is available", () => {
    expect(
      getAvailableComposerSlashCommands({
        provider: "codex",
        supportsFastSlashCommand: true,
        canOfferCompactCommand: true,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
      }),
    ).toContain("compact");

    expect(
      getAvailableComposerSlashCommands({
        provider: "codex",
        supportsFastSlashCommand: true,
        canOfferCompactCommand: false,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
      }),
    ).not.toContain("compact");
  });

  it("treats claude aliases like /fork as provider-native collisions", () => {
    expect(hasProviderNativeSlashCommand("claudeAgent", ["branch", "model"], "fork")).toBe(true);
    expect(hasProviderNativeSlashCommand("claudeAgent", ["clear"], "reset")).toBe(true);
  });
});
