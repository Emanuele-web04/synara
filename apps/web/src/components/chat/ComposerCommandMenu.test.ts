import { describe, expect, it } from "vitest";
import { groupCommandItems, type ComposerCommandItem } from "./ComposerCommandMenu";

describe("groupCommandItems", () => {
  it("groups mention suggestions as plugins, local, then subagents", () => {
    const items: ComposerCommandItem[] = [
      {
        id: "agent:codex:mini",
        type: "agent",
        provider: "codex",
        alias: "mini",
        color: "violet",
        label: "@mini",
        description: "GPT-5.4 Mini",
      },
      {
        id: "path:file:/workspace/AGENTS.md",
        type: "path",
        path: "/workspace/AGENTS.md",
        pathKind: "file",
        label: "AGENTS.md",
        description: "/workspace",
      },
      {
        id: "plugin:github",
        type: "plugin",
        plugin: {
          id: "plugin/github",
          name: "GitHub",
          source: {
            type: "local",
            path: "/test/plugins/github",
          },
          interface: {
            displayName: "GitHub",
            shortDescription: "Triage PRs and CI",
          },
          installed: true,
          enabled: true,
          installPolicy: "AVAILABLE",
          authPolicy: "ON_USE",
        },
        mention: {
          name: "GitHub",
          path: "plugin://GitHub@codex",
        },
        label: "GitHub",
        description: "Triage PRs and CI",
      },
      {
        id: "local-root",
        type: "local-root",
        label: "@local",
        description: "Browse folders on this computer",
      },
    ];

    expect(groupCommandItems(items, "mention", true)).toEqual([
      {
        id: "plugins",
        label: "Plugins",
        items: [items[2]],
      },
      {
        id: "local",
        label: "Local",
        items: [items[1], items[3]],
      },
      {
        id: "subagents",
        label: "Subagents",
        items: [items[0]],
      },
    ]);
  });

  it("groups slash-menu app skills with built-in commands", () => {
    const items: ComposerCommandItem[] = [
      {
        id: "slash:fork",
        type: "slash-command",
        command: "fork",
        label: "/fork",
        description: "Fork thread",
        source: "app",
      },
      {
        id: "app-skill:live-edit",
        type: "app-skill",
        skillId: "live-edit",
        label: "Live Edit",
        trigger: "/live-edit",
        description: "Start a local frontend preview",
      },
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch model",
        source: "app",
      },
      {
        id: "provider-command:codex:help",
        type: "provider-native-command",
        provider: "codex",
        command: "help",
        label: "/help",
        description: "Show help",
      },
      {
        id: "skill:/workspace/.codex/skills/check-code/SKILL.md",
        type: "skill",
        skill: {
          name: "check-code",
          description: "Review recent code changes",
          path: "/workspace/.codex/skills/check-code/SKILL.md",
          enabled: true,
          scope: "project",
        },
        label: "check-code",
        description: "Review recent code changes",
      },
    ];

    expect(groupCommandItems(items, "slash-command", true)).toEqual([
      {
        id: "built-in",
        label: "Built-in",
        items: [items[0], items[1], items[2]],
      },
      {
        id: "provider",
        label: "Provider",
        items: [items[3]],
      },
      {
        id: "skills",
        label: "Skills",
        items: [items[4]],
      },
    ]);
  });
});
