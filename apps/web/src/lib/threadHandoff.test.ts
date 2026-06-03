import { MessageId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildOutgoingThreadHandoffLinks,
  buildThreadHandoffContextPreview,
  resolveAvailableHandoffTargetProviders,
  resolvePrimaryOutgoingThreadHandoffLink,
  resolveThreadHandoffBadgeLabel,
  resolveThreadHandoffTitle,
  resolveThreadHandoffModelSelection,
  resolveThreadOutgoingHandoffLabel,
  resolveThreadOutgoingHandoffTooltip,
} from "./threadHandoff";
import type { Thread } from "../types";

function makePreviewThread(input?: {
  messages?: Thread["messages"];
  title?: string;
}): Pick<Thread, "branch" | "messages" | "modelSelection" | "title" | "worktreePath"> {
  return {
    title: input?.title ?? "Preview handoff",
    branch: "feature/preview",
    worktreePath: "/repo/.worktrees/preview",
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    messages:
      input?.messages ??
      [
        {
          id: MessageId.makeUnsafe("msg-user-preview"),
          role: "user",
          text: "Please fix the auth loop.\n\n<assistant_selection>\n- assistant message msg-assistant-1:\n  Internal selected quote\n</assistant_selection>",
          turnId: null,
          createdAt: "2026-06-03T12:00:00.000Z",
          completedAt: "2026-06-03T12:00:01.000Z",
          streaming: false,
          source: "native",
        },
        {
          id: MessageId.makeUnsafe("msg-assistant-preview"),
          role: "assistant",
          text: "I traced it to the redirect guard.",
          turnId: null,
          createdAt: "2026-06-03T12:00:02.000Z",
          completedAt: "2026-06-03T12:00:03.000Z",
          streaming: false,
          source: "native",
        },
      ],
  };
}

describe("threadHandoff", () => {
  const sourceThread = {
    id: "thread-source" as Thread["id"],
    projectId: "project-1" as Thread["projectId"],
  };

  it("lists all supported handoff targets except the active provider", () => {
    expect(resolveAvailableHandoffTargetProviders("codex")).toEqual([
      "claudeAgent",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "opencode",
      "pi",
    ]);
    expect(resolveAvailableHandoffTargetProviders("claudeAgent")).toEqual([
      "codex",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "opencode",
      "pi",
    ]);
    expect(resolveAvailableHandoffTargetProviders("cursor")).toEqual([
      "codex",
      "claudeAgent",
      "gemini",
      "grok",
      "kilo",
      "opencode",
      "pi",
    ]);
    expect(resolveAvailableHandoffTargetProviders("gemini")).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "kilo",
      "opencode",
      "pi",
    ]);
    expect(resolveAvailableHandoffTargetProviders("grok")).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "gemini",
      "kilo",
      "opencode",
      "pi",
    ]);
    expect(resolveAvailableHandoffTargetProviders("kilo")).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "gemini",
      "grok",
      "opencode",
      "pi",
    ]);
    expect(resolveAvailableHandoffTargetProviders("opencode")).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "pi",
    ]);
    expect(resolveAvailableHandoffTargetProviders("pi")).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "opencode",
    ]);
  });

  it("preserves the source thread title for the created handoff thread", () => {
    expect(resolveThreadHandoffTitle({ title: "General Greeting" })).toBe("General Greeting");
    expect(resolveThreadHandoffTitle({ title: "  Debug   Grok handoff  " })).toBe(
      "Debug Grok handoff",
    );
  });

  it("labels incoming and outgoing handoff links as continuations", () => {
    const targetThread = {
      handoff: {
        sourceThreadId: sourceThread.id,
        sourceProvider: "codex",
        importedAt: "2026-06-03T12:00:00.000Z",
        bootstrapStatus: "completed",
      },
    } satisfies Pick<Thread, "handoff">;
    const outgoingLink = {
      threadId: "thread-target" as Thread["id"],
      title: "Debug on Claude",
      provider: "claudeAgent",
      sourceThreadId: sourceThread.id,
      sourceProvider: "codex",
      importedAt: "2026-06-03T12:00:00.000Z",
    };

    expect(resolveThreadHandoffBadgeLabel(targetThread)).toBe("Continued from Codex");
    expect(resolveThreadOutgoingHandoffLabel(outgoingLink)).toBe("Continued with Claude");
    expect(resolveThreadOutgoingHandoffTooltip(outgoingLink, 2)).toBe(
      "Continued with Claude; 2 more continuations",
    );
    expect(resolveThreadOutgoingHandoffTooltip(outgoingLink, 1)).toBe(
      "Continued with Claude; 1 more continuation",
    );
  });

  it("builds outgoing handoff links from projected target metadata", () => {
    const links = buildOutgoingThreadHandoffLinks({
      sourceThread,
      threads: [
        {
          id: sourceThread.id,
          projectId: sourceThread.projectId,
          title: "Source",
          modelSelection: { provider: "codex", model: "gpt-5.5" },
          handoff: null,
        },
        {
          id: "thread-old-target" as Thread["id"],
          projectId: sourceThread.projectId,
          title: "Older target",
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
          handoff: {
            sourceThreadId: sourceThread.id,
            sourceProvider: "codex",
            importedAt: "2026-06-03T12:00:00.000Z",
            bootstrapStatus: "completed",
          },
        },
        {
          id: "thread-new-target" as Thread["id"],
          projectId: sourceThread.projectId,
          title: "Newer target",
          modelSelection: { provider: "gemini", model: "gemini-3.1-pro-preview" },
          handoff: {
            sourceThreadId: sourceThread.id,
            sourceProvider: "codex",
            importedAt: "2026-06-03T13:00:00.000Z",
            bootstrapStatus: "pending",
          },
        },
        {
          id: "thread-archived-target" as Thread["id"],
          projectId: sourceThread.projectId,
          title: "Archived target",
          modelSelection: { provider: "grok", model: "grok-4.1" },
          archivedAt: "2026-06-03T13:30:00.000Z",
          handoff: {
            sourceThreadId: sourceThread.id,
            sourceProvider: "codex",
            importedAt: "2026-06-03T13:30:00.000Z",
            bootstrapStatus: "completed",
          },
        },
        {
          id: "thread-other-project" as Thread["id"],
          projectId: "project-2" as Thread["projectId"],
          title: "Other project",
          modelSelection: { provider: "opencode", model: "opencode/sonic" },
          handoff: {
            sourceThreadId: sourceThread.id,
            sourceProvider: "codex",
            importedAt: "2026-06-03T14:00:00.000Z",
            bootstrapStatus: "completed",
          },
        },
      ],
    });

    expect(links.map((link) => link.threadId)).toEqual([
      "thread-new-target",
      "thread-old-target",
    ]);
    expect(resolvePrimaryOutgoingThreadHandoffLink(links)?.title).toBe("Newer target");
  });

  it("prefers sticky model selection for the chosen handoff target", () => {
    const stickySelection = {
      provider: "gemini",
      model: "gemini-2.5-pro",
    } satisfies ModelSelection;

    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        },
        targetProvider: "gemini",
        projectDefaultModelSelection: {
          provider: "gemini",
          model: "gemini-3.1-pro-preview",
        },
        stickyModelSelectionByProvider: {
          gemini: stickySelection,
        },
      }),
    ).toEqual(stickySelection);
  });

  it("falls back to the resolved provider default model when no sticky or project default exists", () => {
    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "gemini",
            model: "gemini-2.5-pro",
          },
        },
        targetProvider: "codex",
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {},
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.5",
    });
  });

  it("builds a context preview from imported handoff messages", () => {
    const preview = buildThreadHandoffContextPreview({
      thread: makePreviewThread(),
      latestUserMessageText: "continue with this prompt",
    });

    expect(preview).toContain("This conversation was handed off from codex.");
    expect(preview).toContain("Original conversation title: Preview handoff");
    expect(preview).toContain("Git branch: feature/preview");
    expect(preview).toContain("Please fix the auth loop.");
    expect(preview).toContain("I traced it to the redirect guard.");
    expect(preview).not.toContain("<assistant_selection>");
    expect(preview).not.toContain("Internal selected quote");
  });

  it("shrinks the context preview budget based on the current draft prompt", () => {
    const shortPromptPreview = buildThreadHandoffContextPreview({
      thread: makePreviewThread({
        messages: [
          {
            id: MessageId.makeUnsafe("msg-user-budget"),
            role: "user",
            text: "x".repeat(4_000),
            turnId: null,
            createdAt: "2026-06-03T12:00:00.000Z",
            completedAt: "2026-06-03T12:00:01.000Z",
            streaming: false,
            source: "native",
          },
        ],
      }),
      latestUserMessageText: "",
    });
    const longPromptPreview = buildThreadHandoffContextPreview({
      thread: makePreviewThread({
        messages: [
          {
            id: MessageId.makeUnsafe("msg-user-budget"),
            role: "user",
            text: "x".repeat(4_000),
            turnId: null,
            createdAt: "2026-06-03T12:00:00.000Z",
            completedAt: "2026-06-03T12:00:01.000Z",
            streaming: false,
            source: "native",
          },
        ],
      }),
      latestUserMessageText: "y".repeat(119_500),
    });

    expect(shortPromptPreview?.length).toBeGreaterThan(longPromptPreview?.length ?? 0);
    expect(longPromptPreview?.endsWith("...")).toBe(true);
  });

  it("returns null when no transferable messages exist", () => {
    expect(
      buildThreadHandoffContextPreview({
        thread: makePreviewThread({
          messages: [
            {
              id: MessageId.makeUnsafe("msg-system-only"),
              role: "system",
              text: "not transferable",
              turnId: null,
              createdAt: "2026-06-03T12:00:00.000Z",
              completedAt: "2026-06-03T12:00:01.000Z",
              streaming: false,
              source: "native",
            },
          ],
        }),
        latestUserMessageText: "",
      }),
    ).toBeNull();
  });
});
