import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { AppSettingsSchema, getProviderInstanceOptions } from "../appSettings";
import type { Thread } from "../types";
import {
  buildThreadHandoffImportedActivities,
  buildThreadHandoffImportedMessages,
  buildThreadHandoffContextMenuItems,
  canContinueThreadHandoff,
  resolveAvailableHandoffTargets,
  resolveContinueThreadHandoffTargets,
  resolveProviderHandoffOutcome,
  resolveThreadHandoffAvailability,
  resolveThreadHandoffModelSelection,
} from "./threadHandoff";
import { appendAssistantSelectionsToPrompt } from "./assistantSelections";
import {
  appendBrowserAnnotationsToPrompt,
  extractTrailingBrowserAnnotations,
  type BrowserAnnotationDraft,
} from "./browserAnnotations";

describe("threadHandoff", () => {
  const menuTargets = [
    { provider: "claudeAgent", instanceId: "claudeAgent", label: "Claude" },
    { provider: "grok", instanceId: "grok", label: "Grok" },
    { provider: "codex", instanceId: "codex_work", label: "Codex work" },
  ] as const;

  it("gates explicit Continue here targets without changing available new-conversation targets", () => {
    expect(
      resolveContinueThreadHandoffTargets({
        enabled: false,
        sourceProvider: "codex",
        targets: menuTargets,
      }),
    ).toEqual([]);
    expect(
      resolveContinueThreadHandoffTargets({
        enabled: true,
        sourceProvider: "codex",
        targets: menuTargets,
      }),
    ).toEqual(menuTargets.slice(0, 2));
    expect(menuTargets).toHaveLength(3);
  });

  it("keeps the legacy context menu when opted out even if Continue here targets were supplied", () => {
    const items = buildThreadHandoffContextMenuItems({
      enabled: false,
      targets: menuTargets,
      continueTargets: menuTargets.slice(0, 2),
      icon: "handoff",
    });
    expect(items).toEqual([
      {
        id: "handoff",
        label: "Hand off",
        icon: "handoff",
        children: menuTargets.map((target) => ({
          id: `handoff:${target.instanceId}`,
          label: target.label,
          icon: "handoff",
        })),
      },
    ]);
  });

  it("groups explicit destinations and their target variants instead of adding top-level rows", () => {
    const items = buildThreadHandoffContextMenuItems({
      enabled: true,
      targets: menuTargets,
      continueTargets: menuTargets.slice(0, 2),
      icon: "handoff",
    });
    expect(items).toHaveLength(1);
    const destinations = items[0]!.children!;
    expect(destinations.map((item) => item.label)).toEqual(["Continue here", "New conversation"]);
    expect(destinations[0]!.children?.map((item) => item.id)).toEqual([
      "handoff-here:claudeAgent",
      "handoff-here:grok",
    ]);
    expect(destinations[1]!.children?.map((item) => item.id)).toEqual([
      "handoff:claudeAgent",
      "handoff:grok",
      "handoff:codex_work",
    ]);
  });

  it("collapses one-target outcomes to plain rows and omits empty handoff groups", () => {
    const target = menuTargets[0];
    const items = buildThreadHandoffContextMenuItems({
      enabled: true,
      targets: [target],
      continueTargets: [target],
      icon: "handoff",
    });
    expect(
      items[0]!.children?.map((item) => ({ label: item.label, children: item.children })),
    ).toEqual([
      { label: "Continue here with Claude", children: undefined },
      { label: "New conversation with Claude", children: undefined },
    ]);
    expect(
      buildThreadHandoffContextMenuItems({
        enabled: false,
        targets: [target],
        continueTargets: [],
        icon: "handoff",
      })[0]?.label,
    ).toBe("Handoff to Claude");
    expect(
      buildThreadHandoffContextMenuItems({
        enabled: true,
        targets: [],
        continueTargets: [],
        icon: "handoff",
      }),
    ).toEqual([]);
  });

  it("reads a same-thread handoff outcome from the activity keyed by its command", () => {
    const activity = (id: string, payload: Record<string, unknown> = {}) =>
      ({
        id: EventId.makeUnsafe(id),
        tone: "info",
        kind: "provider.handoff",
        summary: "Handoff summary",
        payload,
        turnId: null,
        createdAt: "2026-10-03T10:00:00.000Z",
      }) as Thread["activities"][number];

    expect(resolveProviderHandoffOutcome({ activities: [] }, "cmd-1")).toEqual({
      status: "pending",
    });
    expect(
      resolveProviderHandoffOutcome({ activities: [activity("provider-handoff:cmd-2")] }, "cmd-1"),
    ).toEqual({ status: "pending" });
    expect(
      resolveProviderHandoffOutcome({ activities: [activity("provider-handoff:cmd-1")] }, "cmd-1"),
    ).toEqual({ status: "completed" });
    expect(
      resolveProviderHandoffOutcome(
        {
          activities: [
            activity("provider-handoff-failed:cmd-1", { detail: "Claude could not start." }),
          ],
        },
        "cmd-1",
      ),
    ).toEqual({ status: "failed", detail: "Claude could not start." });
  });

  it("continues in the same thread only when the provider changes", () => {
    expect(
      canContinueThreadHandoff({ sourceProvider: "codex", targetProvider: "claudeAgent" }),
    ).toBe(true);
    // Another account of the same provider still needs a new thread.
    expect(canContinueThreadHandoff({ sourceProvider: "codex", targetProvider: "codex" })).toBe(
      false,
    );
  });

  const readyStatus = (
    provider: ProviderKind,
    overrides: Partial<ServerProviderStatus> = {},
  ): ServerProviderStatus => ({
    provider,
    instanceId: provider,
    driver: provider,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-08-07T12:00:00.000Z",
    ...overrides,
  });

  it("strips source-thread browser annotations and selections from imported messages", () => {
    const sourceMessageId = MessageId.makeUnsafe("source-user-message");
    const annotation: BrowserAnnotationDraft = {
      id: "annotation-1",
      ordinal: 1,
      tabId: "tab-1",
      source: { url: "https://example.test/docs", pageTitle: "Docs" },
      selector: "main > button",
      tagName: "button",
      role: "button",
      name: "Save",
      text: "Save",
      fingerprint: "button|save|main",
      comment: "Remove this",
      capturedAt: "2026-07-23T10:00:00.000Z",
    };
    const text = appendBrowserAnnotationsToPrompt(
      appendAssistantSelectionsToPrompt("Update the page", [
        { assistantMessageId: "assistant-1", text: "Quoted response" },
      ]),
      [annotation],
      sourceMessageId,
    );

    const [imported] = buildThreadHandoffImportedMessages({
      messages: [
        {
          id: sourceMessageId,
          role: "user",
          text,
          createdAt: "2026-07-23T10:00:00.000Z",
          streaming: false,
          source: "native",
        },
      ],
    });
    expect(imported).toBeTruthy();
    const extracted = extractTrailingBrowserAnnotations(imported!.text, imported!.messageId);
    expect(imported!.messageId).not.toBe(sourceMessageId);
    expect(extracted.promptText).toBe("Update the page");
    expect(extracted.annotations).toEqual([]);
    expect(imported!.text).not.toContain("<browser_annotations>");
    expect(imported!.text).not.toContain("annotation-1");
    expect(imported!.text).not.toContain("<assistant_selection>");
  });

  it("imports only the transcript through the requested message", () => {
    const message = (id: string, role: "user" | "assistant", text: string) => ({
      id: MessageId.makeUnsafe(id),
      role,
      text,
      createdAt: "2026-07-23T10:00:00.000Z",
      streaming: false as const,
      source: "native" as const,
    });
    const thread = {
      messages: [
        message("m1", "user", "first ask"),
        message("m2", "assistant", "first answer"),
        message("m3", "user", "second ask"),
        message("m4", "assistant", "second answer"),
      ],
    };

    const scoped = buildThreadHandoffImportedMessages(thread, {
      throughMessageId: MessageId.makeUnsafe("m2"),
    });
    expect(scoped.map((imported) => imported.text)).toEqual(["first ask", "first answer"]);

    // No cutoff (and an unknown cutoff) keeps the whole importable transcript.
    expect(buildThreadHandoffImportedMessages(thread)).toHaveLength(4);
    expect(
      buildThreadHandoffImportedMessages(thread, {
        throughMessageId: MessageId.makeUnsafe("missing"),
      }),
    ).toHaveLength(4);
  });

  it("drops usage invalidated by the latest compaction before handoff appends", () => {
    const activity = (
      kind: string,
      payload: OrchestrationThreadActivity["payload"] = {},
    ): OrchestrationThreadActivity => ({
      id: EventId.makeUnsafe(`activity-${kind}`),
      createdAt: "2026-07-21T00:00:00.000Z",
      tone: "info",
      kind,
      summary: kind,
      payload,
      turnId: null,
    });

    const imported = buildThreadHandoffImportedActivities({
      activities: [
        activity("context-window.configured"),
        activity("context-window.updated"),
        activity("context-compaction", { state: "compacted" }),
        activity("context-window.updated", { usedTokens: 20_000 }),
        activity("tool.started"),
      ],
    });

    expect(imported.map(({ kind }) => kind)).toEqual([
      "context-compaction",
      "context-window.updated",
    ]);
  });

  it("excludes disabled, missing, unavailable, and unauthenticated handoff targets", () => {
    const providerInstances = getProviderInstanceOptions(
      AppSettingsSchema.makeUnsafe({
        providerInstances: { antigravity: { driver: "antigravity", enabled: false } },
      }),
    );
    expect(
      resolveAvailableHandoffTargets({
        sourceProvider: "codex",
        providerInstances,
        providerStatuses: [
          readyStatus("codex"),
          readyStatus("claudeAgent"),
          readyStatus("cursor", { available: false, status: "error" }),
          readyStatus("antigravity"),
          readyStatus("grok", { authStatus: "unauthenticated" }),
          readyStatus("opencode", { authStatus: "unknown" }),
        ],
      }),
    ).toEqual([
      { provider: "claudeAgent", instanceId: "claudeAgent", label: "Claude" },
      { provider: "opencode", instanceId: "opencode", label: "OpenCode" },
    ]);
  });

  it("does not expose targets before provider health is available", () => {
    expect(
      resolveAvailableHandoffTargets({
        sourceProvider: "codex",
        providerInstances: getProviderInstanceOptions(AppSettingsSchema.makeUnsafe({})),
        providerStatuses: [],
      }),
    ).toEqual([]);
  });

  it("does not borrow a default account's health for unavailable or unchecked accounts", () => {
    const providerInstances = getProviderInstanceOptions(
      AppSettingsSchema.makeUnsafe({
        providerInstances: {
          claude_work: { driver: "claudeAgent", displayName: "Claude work" },
          claude_unchecked: { driver: "claudeAgent", displayName: "Claude unchecked" },
        },
      }),
    );
    expect(
      resolveAvailableHandoffTargets({
        sourceProvider: "codex",
        providerInstances,
        providerStatuses: [
          readyStatus("claudeAgent"),
          readyStatus("claudeAgent", {
            instanceId: "claude_work",
            available: false,
            status: "error",
          }),
        ],
      }),
    ).toEqual([{ provider: "claudeAgent", instanceId: "claudeAgent", label: "Claude" }]);
  });

  it("offers usable accounts of the source provider while excluding only the source account", () => {
    const providerInstances = getProviderInstanceOptions(
      AppSettingsSchema.makeUnsafe({
        providerInstances: {
          claude_personal: { driver: "claudeAgent", displayName: "Claude personal" },
          claude_work: { driver: "claudeAgent", displayName: "Claude work" },
        },
      }),
    );
    expect(
      resolveAvailableHandoffTargets({
        sourceProvider: "claudeAgent",
        sourceProviderInstanceId: "claude_personal",
        providerInstances,
        providerStatuses: [
          readyStatus("claudeAgent"),
          readyStatus("claudeAgent", { instanceId: "claude_personal" }),
          readyStatus("claudeAgent", {
            instanceId: "claude_work",
            status: "warning",
            authStatus: "unknown",
          }),
        ],
      }),
    ).toEqual([
      { provider: "claudeAgent", instanceId: "claudeAgent", label: "Claude" },
      { provider: "claudeAgent", instanceId: "claude_work", label: "Claude work" },
    ]);
  });

  it("prefers sticky model selection for the chosen handoff target", () => {
    const stickySelection = {
      provider: "antigravity",
      instanceId: "antigravity_work",
      model: "Gemini 3.5 Flash",
    } satisfies ModelSelection;

    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        },
        targetProvider: "antigravity",
        targetProviderInstanceId: "antigravity_work",
        projectDefaultModelSelection: {
          provider: "antigravity",
          model: "Claude Sonnet 4.6",
        },
        stickyModelSelectionByProvider: {
          antigravity_work: stickySelection,
        },
      }),
    ).toEqual(stickySelection);
  });

  it("does not borrow provider-only sticky selections for a custom target instance", () => {
    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        },
        targetProvider: "antigravity",
        targetProviderInstanceId: "antigravity_work",
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {
          antigravity: {
            provider: "antigravity",
            model: "Gemini 3.1 Pro",
          },
        },
      }),
    ).toEqual({
      provider: "antigravity",
      instanceId: "antigravity_work",
      model: "Gemini 3.5 Flash",
    });
  });

  it("adds the chosen target instance id to project-default handoff selections", () => {
    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
        },
        targetProvider: "claudeAgent",
        targetProviderInstanceId: "claude_work",
        projectDefaultModelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
        },
        stickyModelSelectionByProvider: {},
      }),
    ).toEqual({
      provider: "claudeAgent",
      instanceId: "claude_work",
      model: "claude-sonnet-4-6",
    });
  });

  it("falls back to the resolved provider default model when no sticky or project default exists", () => {
    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "antigravity",
            model: "Gemini 3.5 Flash",
          },
        },
        targetProvider: "codex",
        targetProviderInstanceId: "codex_personal",
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {},
      }),
    ).toEqual({
      provider: "codex",
      instanceId: "codex_personal",
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
    });
  });

  it("offers provider and workspace handoff for an ordinary project thread", () => {
    expect(
      resolveThreadHandoffAvailability({
        isGroupContainer: false,
        isCoordinatorThread: false,
      }),
    ).toEqual({ providerHandoff: true, workspaceHandoff: true });
  });

  it("keeps provider handoff for a group chat but hides workspace handoff", () => {
    expect(
      resolveThreadHandoffAvailability({
        isGroupContainer: true,
        isCoordinatorThread: false,
      }),
    ).toEqual({ providerHandoff: true, workspaceHandoff: false });
  });

  it("hides every handoff action for the coordinator thread", () => {
    expect(
      resolveThreadHandoffAvailability({
        isGroupContainer: true,
        isCoordinatorThread: true,
      }),
    ).toEqual({ providerHandoff: false, workspaceHandoff: false });
    expect(
      resolveThreadHandoffAvailability({
        isGroupContainer: false,
        isCoordinatorThread: true,
      }),
    ).toEqual({ providerHandoff: false, workspaceHandoff: false });
  });
});
