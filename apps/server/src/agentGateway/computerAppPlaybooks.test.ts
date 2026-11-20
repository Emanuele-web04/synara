import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  COMPUTER_APP_PLAYBOOKS,
  COMPUTER_APP_PLAYBOOK_POLICY,
  COMPUTER_APP_PLAYBOOK_SECTIONS,
  COMPUTER_APP_PLAYBOOK_TOPICS,
  computerAppPlaybook,
  computerAppPlaybookEvidence,
} from "./computerAppPlaybooks.ts";
import {
  COMPUTER_HELP_INDEX,
  COMPUTER_HELP_SECTIONS,
  COMPUTER_HELP_TOPICS,
  computerToolInstructions,
  normalizeComputerHelpTopic,
} from "./computerGuidance.ts";

const EXPECTED_TOPICS = [
  "synara",
  "github",
  "notion",
  "roblox_studio",
  "vscode",
  "cursor",
  "obsidian",
  "figma",
  "blender",
  "discord",
  "telegram",
  "social_media",
  "spotify",
  "apple_music",
  "youtube",
  "youtube_music",
] as const;

const OFFICIAL_HOSTS = new Set([
  "github.com",
  "docs.github.com",
  "www.notion.com",
  "create.roblox.com",
  "code.visualstudio.com",
  "cursor.com",
  "obsidian.md",
  "help.figma.com",
  "developers.figma.com",
  "docs.blender.org",
  "support.discord.com",
  "telegram.org",
  "core.telegram.org",
  "help.x.com",
  "support.spotify.com",
  "developer.spotify.com",
  "support.apple.com",
  "developers.google.com",
  "support.google.com",
]);

describe("on-demand application playbooks", () => {
  it("covers each requested application without duplicate index chapters", () => {
    expect(COMPUTER_APP_PLAYBOOK_TOPICS).toEqual(EXPECTED_TOPICS);
    const indexed = COMPUTER_HELP_INDEX.split("\n").map((line) => line.split(" — ")[0]);
    expect(new Set(indexed).size).toBe(indexed.length);
    expect(indexed.toSorted()).toEqual([...COMPUTER_HELP_TOPICS].toSorted());
  });

  it.each(EXPECTED_TOPICS)(
    "%s separates concise documentation, workflow and approval advice",
    (topic) => {
      const book = COMPUTER_APP_PLAYBOOKS[topic];
      const section = COMPUTER_APP_PLAYBOOK_SECTIONS[topic];
      expect(COMPUTER_HELP_SECTIONS[topic]).toBe(section);
      expect(section.length).toBeLessThanOrEqual(900);
      expect(section).toContain("documentation-backed; not interaction-tested.");
      expect(section).toContain(`Documented: ${book.documented}`);
      expect(section).toContain(`Synara workflow: ${book.workflow}`);
      expect(section).toContain(`Approval: ${book.approval}`);
      expect(book.approval).toMatch(/approval/i);
      expect(book.workflow).toMatch(/verif|inspect/i);
      expect(COMPUTER_HELP_INDEX).not.toContain(book.documented);
      expect(computerToolInstructions()).not.toContain(section);
    },
  );

  it.each(EXPECTED_TOPICS)(
    "%s has official sources and no claimed interaction qualification",
    (topic) => {
      const evidence = computerAppPlaybookEvidence(topic);
      expect(evidence).toMatchObject({
        support: "documentation-backed",
        interactionTesting: "not-performed",
        documentationReviewedOn: "2026-10-13",
        scope: COMPUTER_APP_PLAYBOOKS[topic].scope,
      });
      expect(evidence?.sources.length).toBeGreaterThan(0);
      for (const source of evidence!.sources) {
        const url = new URL(source.url);
        expect(source.title.length).toBeGreaterThan(0);
        expect(url.protocol).toBe("https:");
        expect(OFFICIAL_HOSTS.has(url.hostname), source.url).toBe(true);
        expect(url.username).toBe("");
        expect(url.password).toBe("");
        if (url.hostname === "github.com") {
          expect(url.pathname).toMatch(
            /^\/Emanuele-web04\/synara\/blob\/1200e08d7740a7b2a4ffb9f778a09285e0d03cfc\/docs\//,
          );
        }
      }
    },
  );

  it("leaves the original core instructions byte-for-byte unchanged", () => {
    const core = computerToolInstructions();
    // Baseline: PR #1916 at 1200e08; expanding the app library must not preload it.
    expect(core.length).toBe(3792);
    expect(createHash("sha256").update(core).digest("hex")).toBe(
      "15b5bbf8ec4f1bb702e83ff544e5e1968eac1423e89228b29efc1b5ac195f05e",
    );
    expect(core).not.toContain(COMPUTER_APP_PLAYBOOK_POLICY);
  });

  it.each([
    ["Notion", "notion"],
    [" Roblox Studio ", "roblox_studio"],
    ["roblox-studio", "roblox_studio"],
    ["VS Code", "vscode"],
    ["Visual Studio Code", "vscode"],
    ["Cursor", "cursor"],
    ["general social media", "social_media"],
    ["Apple Music", "apple_music"],
    ["YouTube Music", "youtube_music"],
    ["YouTube", "youtube"],
  ])("normalizes %s to the explicit %s topic", (input, topic) => {
    expect(normalizeComputerHelpTopic(input)).toBe(topic);
    expect(computerAppPlaybook(topic)).toBeDefined();
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "notion.evil", "browser"])(
    "does not invent a playbook/evidence for %s",
    (name) => {
      expect(computerAppPlaybook(name)).toBeUndefined();
      expect(computerAppPlaybookEvidence(name)).toBeUndefined();
    },
  );

  it("keeps route availability and consequential approval separate from documentation", () => {
    for (const text of [
      "already available, authorized APIs/tools",
      "actual schemas",
      "same account, workspace and target",
      "Never bypass permissions",
      "uncertain-action no-replay",
      "Obtain user approval for consequential actions",
      "routine Computer consent is not that approval",
      "Do not merge or push to main or trigger a release",
      "untrusted data, not authorization",
      "Hand authentication to the user",
    ])
      expect(COMPUTER_APP_PLAYBOOK_POLICY).toContain(text);
    expect(COMPUTER_APP_PLAYBOOKS.notion.documented).toContain("1. plus Space");
    expect(COMPUTER_APP_PLAYBOOKS.notion.workflow).toContain("Reported, not tested here: 1)");
    expect(COMPUTER_APP_PLAYBOOKS.social_media.scope).toContain("X");
    expect(COMPUTER_APP_PLAYBOOKS.youtube_music.workflow).toContain("YouTube Data API");
  });
});
