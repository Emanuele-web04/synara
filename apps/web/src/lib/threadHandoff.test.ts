import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_ORDER } from "../providerOrdering";
import {
  buildThreadHandoffImportedActivities,
  buildThreadHandoffImportedMessages,
  resolveAvailableHandoffTargetProviders,
  resolvePendingProviderHandoff,
  resolveProviderHandoffTrail,
  resolveThreadHandoffTitle,
  resolveThreadHandoffModelSelection,
} from "./threadHandoff";
import { appendAssistantSelectionsToPrompt } from "./assistantSelections";
import {
  appendBrowserAnnotationsToPrompt,
  extractTrailingBrowserAnnotations,
  type BrowserAnnotationDraft,
} from "./browserAnnotations";

describe("threadHandoff", () => {
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
    const readyStatus = (
      provider: ProviderKind,
      overrides: Partial<ServerProviderStatus> = {},
    ): ServerProviderStatus => ({
      provider,
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-08-07T12:00:00.000Z",
      ...overrides,
    });
    const providerSettings = {
      ...DEFAULT_SERVER_SETTINGS_VIEW.providers,
      antigravity: {
        ...DEFAULT_SERVER_SETTINGS_VIEW.providers.antigravity,
        enabled: false,
      },
    };

    expect(
      resolveAvailableHandoffTargetProviders({
        sourceProvider: "codex",
        providerSettings,
        providerStatuses: [
          readyStatus("codex"),
          readyStatus("claudeAgent"),
          readyStatus("cursor", { available: false, status: "error" }),
          readyStatus("antigravity"),
          readyStatus("grok", { authStatus: "unauthenticated" }),
          readyStatus("opencode", { authStatus: "unknown" }),
        ],
      }),
    ).toEqual(["claudeAgent", "opencode"]);
  });

  it("does not expose targets before enabled-provider settings are available", () => {
    expect(
      resolveAvailableHandoffTargetProviders({
        sourceProvider: "codex",
        providerSettings: undefined,
        providerStatuses: [
          {
            provider: "claudeAgent",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: "2026-08-07T12:00:00.000Z",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("supports every configured Synara provider as a continuous handoff target", () => {
    const providers = DEFAULT_PROVIDER_ORDER;
    const providerStatuses = providers.map(
      (provider): ServerProviderStatus => ({
        provider,
        status: "ready",
        available: true,
        authStatus: provider === "opencode" ? "unknown" : "authenticated",
        checkedAt: "2026-09-10T10:00:00.000Z",
      }),
    );

    for (const sourceProvider of providers) {
      expect(
        resolveAvailableHandoffTargetProviders({
          sourceProvider,
          providerSettings: DEFAULT_SERVER_SETTINGS_VIEW.providers,
          providerStatuses,
        }),
      ).toEqual(providers.filter((provider) => provider !== sourceProvider));
    }
  });

  it("preserves the source thread title for the created handoff thread", () => {
    expect(resolveThreadHandoffTitle({ title: "General Greeting" })).toBe("General Greeting");
    expect(resolveThreadHandoffTitle({ title: "  Debug   Grok handoff  " })).toBe(
      "Debug Grok handoff",
    );
  });

  it("prefers sticky model selection for the chosen handoff target", () => {
    const stickySelection = {
      provider: "antigravity",
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
        projectDefaultModelSelection: {
          provider: "antigravity",
          model: "Claude Sonnet 4.6",
        },
        stickyModelSelectionByProvider: {
          antigravity: stickySelection,
        },
      }),
    ).toEqual(stickySelection);
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
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {},
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.5",
    });
  });

  it("uses the discovered Pi model when Pi has no static default", () => {
    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: { provider: "codex", model: "gpt-5.5" },
        },
        targetProvider: "pi",
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {},
        discoveredFallbackModel: "openai/gpt-5.5",
      }),
    ).toEqual({ provider: "pi", model: "openai/gpt-5.5" });
  });

  it("keeps the handoff pending until a matching terminal activity arrives", () => {
    const pending = {
      kind: "provider.handoff.requested",
      payload: {
        handoffCommandId: "handoff-1",
        sourceModelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
        targetModelSelection: { provider: "grok", model: "grok-code" },
      },
    };
    expect(resolvePendingProviderHandoff([pending])).toMatchObject({
      handoffCommandId: "handoff-1",
      targetModelSelection: { provider: "grok" },
    });
    expect(
      resolvePendingProviderHandoff([
        pending,
        {
          kind: "provider.handoff.completed",
          payload: {
            handoffCommandId: "handoff-1",
            sourceModelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
            targetModelSelection: { provider: "grok", model: "grok-code" },
          },
        },
      ]),
    ).toBeNull();
    expect(
      resolvePendingProviderHandoff([
        pending,
        {
          kind: "provider.handoff.failed",
          payload: {
            handoffCommandId: "handoff-1",
            sourceModelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
            targetModelSelection: { provider: "grok", model: "grok-code" },
          },
        },
      ]),
    ).toBeNull();
  });

  it("builds an ordered provider trail and marks returns", () => {
    const activity = (
      id: string,
      sourceProvider: ProviderKind,
      targetProvider: ProviderKind,
    ): Pick<OrchestrationThreadActivity, "kind" | "payload"> => ({
      kind: "provider.handoff.completed",
      payload: {
        sourceModelSelection: { provider: sourceProvider, model: `${sourceProvider}-model` },
        targetModelSelection: { provider: targetProvider, model: `${targetProvider}-model` },
        id,
      },
    });

    expect(
      resolveProviderHandoffTrail([
        activity("one", "claudeAgent", "antigravity"),
        activity("two", "antigravity", "codex"),
        activity("three", "codex", "grok"),
        activity("four", "grok", "claudeAgent"),
      ]),
    ).toEqual([
      { provider: "claudeAgent", isReturn: false },
      { provider: "antigravity", isReturn: false },
      { provider: "codex", isReturn: false },
      { provider: "grok", isReturn: false },
      { provider: "claudeAgent", isReturn: true },
    ]);
  });
});
