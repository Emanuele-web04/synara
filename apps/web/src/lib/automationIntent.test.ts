// FILE: automationIntent.test.ts
// Purpose: Locks down chat-composer automation intent parsing.
// Layer: Web lib test
// Depends on: parseChatAutomationIntent and cadence formatting.

import { DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  extractPlainChatAutomationCreationInvocation,
  extractChatAutomationInvocation,
  formatAutomationIntentCadence,
  parseChatAutomationInvocation,
  parseChatAutomationIntent,
  parsePlainChatAutomationInvocation,
  resolveChatAutomationIntent,
  shouldGenerateAutomationIntent,
} from "./automationIntent";

describe("parseChatAutomationIntent", () => {
  it("extracts explicit slash and inline automation invocations", () => {
    expect(extractChatAutomationInvocation("/automation every 6h check the site")).toBe(
      "every 6h check the site",
    );
    expect(extractChatAutomationInvocation("please @automation ogni 6 ore controlla il sito")).toBe(
      "please ogni 6 ore controlla il sito",
    );
    expect(extractChatAutomationInvocation("please /automation every 6h check the site")).toBe(
      "please every 6h check the site",
    );
    expect(extractChatAutomationInvocation("just chat every 6h")).toBeNull();
    expect(extractChatAutomationInvocation("/automate every 6h check the site")).toBeNull();
    expect(extractChatAutomationInvocation("$automation every 6h check the site")).toBeNull();
  });

  it("turns an explicit heartbeat-style request into an interval automation intent", () => {
    const intent = parseChatAutomationIntent(
      "/automation make an automation where you wake up every 6h and check if on this website the black google fitbit air is available in black https://www.amazon.it/example",
    );

    expect(intent).toMatchObject({
      cadenceLabel: "Every 6h",
      prompt:
        "check if on this website the black google fitbit air is available in black https://www.amazon.it/example",
      schedule: { type: "interval", everySeconds: 21_600 },
    });
    expect(intent?.name).toContain("availability");
  });

  it("parses an already-extracted invocation without re-reading the composer marker", () => {
    const intent = parseChatAutomationInvocation("every 6h check the website");

    expect(intent).toMatchObject({
      cadenceLabel: "Every 6h",
      prompt: "check the website",
      schedule: { type: "interval", everySeconds: 21_600 },
      completionPolicy: { type: "none" },
    });
  });

  it("extracts bounded run counts from fast recurring chat automation prompts", () => {
    const intent = parseChatAutomationIntent("/automation say hi every 15 seconds for 3 times");

    expect(intent).toMatchObject({
      cadenceLabel: "Every 15s",
      prompt: "say hi",
      schedule: { type: "interval", everySeconds: 15 },
      maxIterations: 3,
      completionPolicy: { type: "none" },
      executionScope: "thread",
    });

    expect(
      parseChatAutomationIntent("/automation say hi every 15 seconds 3 times total"),
    ).toMatchObject({
      cadenceLabel: "Every 15s",
      prompt: "say hi",
      schedule: { type: "interval", everySeconds: 15 },
      maxIterations: 3,
      executionScope: "thread",
    });

    expect(
      parseChatAutomationIntent("/automation say hi every 15 seconds per un totale di 3 volte"),
    ).toMatchObject({
      cadenceLabel: "Every 15s",
      prompt: "say hi",
      schedule: { type: "interval", everySeconds: 15 },
      maxIterations: 3,
      executionScope: "thread",
    });
  });

  it("keeps bare scheduled statements in normal chat while explicit prompts can still be bounded", () => {
    expect(parsePlainChatAutomationInvocation("say hi every 15 seconds for 3 times")).toBeNull();

    const deterministicIntent = parseChatAutomationIntent(
      "/automation say hi every 15 seconds for 3 times",
    );
    const resolved = resolveChatAutomationIntent({
      deterministicIntent,
      generatedIntent: null,
      defaultMode: "heartbeat",
      executionScope: deterministicIntent?.executionScope ?? "thread",
    });

    expect(resolved).toMatchObject({
      mode: "heartbeat",
      requiresReview: false,
      intent: {
        prompt: "say hi",
        schedule: { type: "interval", everySeconds: 15 },
        maxIterations: 3,
        executionScope: "thread",
      },
    });
    expect(parseChatAutomationInvocation("what is standalone?")).toBeNull();
  });

  it("keeps unmarked automation questions in normal chat", () => {
    expect(parsePlainChatAutomationInvocation("how do automations work every day?")).toBeNull();
    expect(parsePlainChatAutomationInvocation("what is standalone?")).toBeNull();
    expect(
      parsePlainChatAutomationInvocation("come funzionano le automazioni ogni giorno?"),
    ).toBeNull();
    expect(parsePlainChatAutomationInvocation("can automations run every day?")).toBeNull();
    expect(
      parsePlainChatAutomationInvocation("can you write a script that runs every 5 minutes?"),
    ).toBeNull();
    expect(
      parsePlainChatAutomationInvocation("could you tell me how automations work every day?"),
    ).toBeNull();
    expect(parsePlainChatAutomationInvocation("tell me how automations work every day")).toBeNull();

    expect(
      parseChatAutomationIntent("/automation how do automations work every day?"),
    ).toMatchObject({
      cadenceLabel: "Daily at 09:00",
      prompt: "how do automations work ?",
    });
  });

  it("accepts polite unmarked automation requests", () => {
    expect(
      parsePlainChatAutomationInvocation("can you remind me every day to stretch?"),
    ).toMatchObject({
      cadenceLabel: "Daily at 09:00",
      prompt: "remind me stretch",
      schedule: { type: "daily", timeOfDay: "09:00" },
      executionScope: "thread",
    });

    expect(
      parsePlainChatAutomationInvocation(
        "could you check the website every 15 seconds for 3 times",
      ),
    ).toMatchObject({
      cadenceLabel: "Every 15s",
      prompt: "check the website",
      schedule: { type: "interval", everySeconds: 15 },
      maxIterations: 3,
      executionScope: "thread",
    });

    expect(
      parsePlainChatAutomationInvocation("could you say hi every 15 seconds for 3 times"),
    ).toMatchObject({
      cadenceLabel: "Every 15s",
      prompt: "say hi",
      schedule: { type: "interval", everySeconds: 15 },
      maxIterations: 3,
      executionScope: "thread",
    });
  });

  it("accepts explicit unmarked automation creation requests", () => {
    expect(
      parsePlainChatAutomationInvocation(
        "make an automation where you wake up every 6h and check if the black Fitbit is available",
      ),
    ).toMatchObject({
      cadenceLabel: "Every 6h",
      prompt: "check if the black Fitbit is available",
      schedule: { type: "interval", everySeconds: 21_600 },
      executionScope: "thread",
    });

    expect(
      parsePlainChatAutomationInvocation(
        "crea un'automazione ogni 6 ore che controlla se il Fitbit nero e disponibile",
      ),
    ).toMatchObject({
      cadenceLabel: "Every 6h",
      prompt: "controlla se il Fitbit nero e disponibile",
      schedule: { type: "interval", everySeconds: 21_600 },
      executionScope: "thread",
    });

    expect(
      extractPlainChatAutomationCreationInvocation(
        "could you create an automation tomorrow morning to check the queue?",
      ),
    ).toBe("create an automation tomorrow morning to check the queue");
  });

  it("detects explicit standalone and worktree scopes without saving scope scaffolding", () => {
    expect(parseChatAutomationIntent("/automation run standalone every 5m check CI")).toMatchObject(
      {
        cadenceLabel: "Every 5m",
        prompt: "check CI",
        schedule: { type: "interval", everySeconds: 300 },
        executionScope: "standalone",
      },
    );

    expect(
      parseChatAutomationIntent("/automation in a new worktree every 5m check CI"),
    ).toMatchObject({
      cadenceLabel: "Every 5m",
      prompt: "check CI",
      schedule: { type: "interval", everySeconds: 300 },
      executionScope: "worktree",
    });

    expect(
      parseChatAutomationIntent("/automation every 5m check whether the new run finished"),
    ).toMatchObject({
      cadenceLabel: "Every 5m",
      prompt: "check whether the new run finished",
      schedule: { type: "interval", everySeconds: 300 },
      executionScope: "thread",
    });

    expect(parseChatAutomationIntent("/automation every 5m check CI as a new run")).toMatchObject({
      cadenceLabel: "Every 5m",
      prompt: "check CI",
      schedule: { type: "interval", everySeconds: 300 },
      executionScope: "standalone",
    });
  });

  it("extracts English stop clauses into first-class completion policies", () => {
    expect(
      parseChatAutomationInvocation(
        "every 3 min watch codex-bot. Stop when codex-bot says the PR is ready to merge. If there are actionable issues, fix them and keep monitoring.",
      ),
    ).toMatchObject({
      prompt: "watch codex-bot. If there are actionable issues, fix them and keep monitoring.",
      completionPolicy: {
        type: "ai-evaluated",
        stopWhen: "codex-bot says the PR is ready to merge",
        confidenceThreshold: DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
      },
    });

    expect(
      parseChatAutomationInvocation("every 5 min keep monitoring until CI is green"),
    ).toMatchObject({
      prompt: "keep monitoring",
      completionPolicy: {
        type: "ai-evaluated",
        stopWhen: "CI is green",
      },
    });

    expect(
      parseChatAutomationInvocation("every 10 min check the PR; if there are no issues, stop"),
    ).toMatchObject({
      completionPolicy: {
        type: "ai-evaluated",
        stopWhen: "there are no issues",
      },
    });
  });

  it("extracts Italian stop clauses into first-class completion policies", () => {
    expect(
      parseChatAutomationInvocation("ogni 5 minuti controlla la PR finché è pronta"),
    ).toMatchObject({
      completionPolicy: {
        type: "ai-evaluated",
        stopWhen: "è pronta",
      },
    });

    expect(
      parseChatAutomationInvocation("ogni 5 minuti controlla la PR. Quando è pronta, fermati"),
    ).toMatchObject({
      completionPolicy: {
        type: "ai-evaluated",
        stopWhen: "è pronta",
      },
    });
  });

  it("parses English and Italian one-shot timers from a deterministic now", () => {
    expect(
      parseChatAutomationInvocation("in 15 seconds remind me here", {
        nowIso: "2026-06-19T10:00:00.000Z",
      }),
    ).toMatchObject({
      cadenceLabel: "In 15s",
      schedule: { type: "once", runAt: "2026-06-19T10:00:15.000Z" },
      prompt: "remind me here",
    });

    expect(
      parseChatAutomationInvocation("tra 5 minuti controlla il deploy", {
        nowIso: "2026-06-19T10:00:00.000Z",
      }),
    ).toMatchObject({
      cadenceLabel: "In 5m",
      schedule: { type: "once", runAt: "2026-06-19T10:05:00.000Z" },
      prompt: "controlla il deploy",
    });

    expect(
      parseChatAutomationIntent("/automation fra 15 secondi scrivi qui: test automation ok", {
        nowIso: "2026-06-19T10:00:00.000Z",
      }),
    ).toMatchObject({
      cadenceLabel: "In 15s",
      schedule: { type: "once", runAt: "2026-06-19T10:00:15.000Z" },
      prompt: "scrivi qui: test automation ok",
    });
  });

  it("parses recurring second intervals for acknowledgement in the draft", () => {
    expect(parseChatAutomationInvocation("every 15 seconds check logs")).toMatchObject({
      cadenceLabel: "Every 15s",
      prompt: "check logs",
      schedule: { type: "interval", everySeconds: 15 },
    });
    expect(parseChatAutomationInvocation("ogni 60 secondi controlla i log")).toMatchObject({
      schedule: { type: "interval", everySeconds: 60 },
    });
  });

  it("parses cron schedules and preserves skill references in the prompt", () => {
    const intent = parseChatAutomationInvocation("cron 0 9 * * * run $check-code on stale PRs");

    expect(intent).toMatchObject({
      cadenceLabel: "Cron 0 9 * * *",
      prompt: "run $check-code on stale PRs",
      schedule: { type: "cron", expression: "0 9 * * *" },
    });
  });

  it("accepts Italian automation creation phrasing", () => {
    const intent = parseChatAutomationIntent(
      "@automation crea un'automazione ogni 6 ore che controlla se il Fitbit nero e disponibile",
    );

    expect(intent).toMatchObject({
      cadenceLabel: "Every 6h",
      prompt: "controlla se il Fitbit nero e disponibile",
      schedule: { type: "interval", everySeconds: 21_600 },
    });
  });

  it("accepts direct scheduled action phrasing once explicitly invoked", () => {
    const intent = parseChatAutomationIntent(
      "/automation check every 30 min if the staging site is up",
    );

    expect(intent).toMatchObject({
      cadenceLabel: "Every 30m",
      prompt: "check if the staging site is up",
      schedule: { type: "interval", everySeconds: 1_800 },
    });
  });

  it("accepts inline slash automation chips as app automation invocations", () => {
    expect(parseChatAutomationIntent("please /automation every 6h check the site")).toMatchObject({
      cadenceLabel: "Every 6h",
      prompt: "check the site",
      schedule: { type: "interval", everySeconds: 21_600 },
    });
  });

  it("parses daily and weekday schedules", () => {
    expect(
      parseChatAutomationIntent("/automation schedule a check daily at 9:30 to scan the changelog"),
    ).toMatchObject({
      cadenceLabel: "Daily at 09:30",
      schedule: { type: "daily", timeOfDay: "09:30" },
    });

    expect(
      parseChatAutomationIntent("@automation remind me weekdays at 18 to write the standup note"),
    ).toMatchObject({
      cadenceLabel: "Weekdays at 18:00",
      schedule: { type: "weekdays", timeOfDay: "18:00" },
    });
  });

  it("parses meridiem times instead of falling back to the default daily time", () => {
    expect(parseChatAutomationIntent("/automation daily at 9pm check the queue")).toMatchObject({
      cadenceLabel: "Daily at 21:00",
      prompt: "check the queue",
      schedule: { type: "daily", timeOfDay: "21:00" },
    });

    expect(parseChatAutomationIntent("/automation weekdays at 12am check logs")).toMatchObject({
      cadenceLabel: "Weekdays at 00:00",
      prompt: "check logs",
      schedule: { type: "weekdays", timeOfDay: "00:00" },
    });
  });

  it("does not default to 09:00 when an explicit time clause is unsupported", () => {
    expect(parseChatAutomationIntent("/automation daily at bedtime check the queue")).toBeNull();
  });

  it("requires a real task after removing the schedule scaffold", () => {
    expect(parseChatAutomationInvocation("every 5m")).toBeNull();
    expect(parseChatAutomationIntent("/automation daily at 9pm")).toBeNull();
  });

  it("strips weekday and weekly cadence text from deterministic prompts", () => {
    expect(parseChatAutomationIntent("/automation every Monday at 9 check CI")).toMatchObject({
      cadenceLabel: "Weekly at 09:00",
      prompt: "check CI",
      schedule: { type: "weekly", dayOfWeek: 1, timeOfDay: "09:00" },
    });

    expect(
      parseChatAutomationIntent("@automation weekdays at 18 write standup note"),
    ).toMatchObject({
      cadenceLabel: "Weekdays at 18:00",
      prompt: "write standup note",
      schedule: { type: "weekdays", timeOfDay: "18:00" },
    });

    expect(parseChatAutomationIntent("/automation ogni lunedì alle 9 controlla CI")).toMatchObject({
      cadenceLabel: "Weekly at 09:00",
      prompt: "controlla CI",
      schedule: { type: "weekly", dayOfWeek: 1, timeOfDay: "09:00" },
    });
  });

  it("keeps generic automation questions in normal chat", () => {
    expect(parseChatAutomationIntent("how do automations work every day?")).toBeNull();
    expect(parseChatAutomationIntent("check every 30 min if the staging site is up")).toBeNull();
    expect(
      parseChatAutomationIntent("what is the difference between heartbeat and standalone?"),
    ).toBeNull();
  });

  it("formats AI-generated automation cadences", () => {
    expect(formatAutomationIntentCadence({ type: "interval", everySeconds: 21_600 })).toBe(
      "Every 6h",
    );
    expect(formatAutomationIntentCadence({ type: "daily", timeOfDay: "09:30" })).toBe(
      "Daily at 09:30",
    );
  });

  it("only asks for generation when a deterministic prompt is too terse", () => {
    const terseIntent = parseChatAutomationIntent("/automation every 6h check the website");
    const detailedIntent = parseChatAutomationIntent(
      "/automation every 6h check the staging website, inspect the checkout diff, run npm test, and report only confirmed deployment blockers",
    );

    expect(
      shouldGenerateAutomationIntent({
        deterministicIntent: null,
        automationMessage: "tomorrow morning check the queue",
      }),
    ).toBe(true);
    expect(
      shouldGenerateAutomationIntent({
        deterministicIntent: terseIntent,
        automationMessage: "every 6h check the website",
      }),
    ).toBe(true);
    expect(
      shouldGenerateAutomationIntent({
        deterministicIntent: detailedIntent,
        automationMessage:
          "every 6h check the staging website, inspect the checkout diff, run npm test, and report only confirmed deployment blockers",
      }),
    ).toBe(false);
  });

  it("keeps deterministic scheduling while accepting generated prompt enrichment", () => {
    const deterministicIntent = parseChatAutomationIntent("/automation every 6h check the website");

    const resolved = resolveChatAutomationIntent({
      deterministicIntent,
      generatedIntent: {
        isAutomation: true,
        confidence: 1,
        language: "en",
        name: "Generated",
        taskPrompt: "Generated prompt",
        schedule: { type: "daily", timeOfDay: "09:00" },
        mode: "heartbeat",
        completionPolicy: { type: "none" },
        missingFields: [],
        needsConfirmation: false,
        reason: null,
      },
      defaultMode: "heartbeat",
      executionScope: "thread",
    });

    expect(resolved).toMatchObject({
      source: "deterministic",
      mode: "heartbeat",
      // The schedule parsed deterministically, but name/prompt are LLM-rewritten, so the
      // draft must still go through human review even though needsConfirmation was false.
      requiresReview: true,
      intent: {
        name: "Generated",
        prompt: "Generated prompt",
        schedule: { type: "interval", everySeconds: 21_600 },
      },
    });
  });

  it("strips generated scaffolding before merging deterministic prompt enrichment", () => {
    const deterministicIntent = parseChatAutomationIntent(
      "/automation say hi every 15 seconds for 3 times",
    );

    const resolved = resolveChatAutomationIntent({
      deterministicIntent,
      generatedIntent: {
        isAutomation: true,
        confidence: 0.96,
        language: "en",
        name: "Say hi",
        taskPrompt: "Every 15 seconds, say hi in this thread for 3 times.",
        schedule: { type: "interval", everySeconds: 15 },
        mode: "heartbeat",
        completionPolicy: { type: "none" },
        missingFields: [],
        needsConfirmation: true,
        reason: "Fast interval",
      },
      defaultMode: "heartbeat",
      executionScope: "thread",
    });

    expect(resolved).toMatchObject({
      source: "deterministic",
      mode: "heartbeat",
      requiresReview: true,
      generatedNeedsConfirmation: true,
      reason: "Fast interval",
      intent: {
        prompt: "say hi in this thread.",
        schedule: { type: "interval", everySeconds: 15 },
        maxIterations: 3,
      },
    });
  });

  it("preserves generated standalone mode when deterministic scope parsing misses the phrasing", () => {
    const deterministicIntent = parseChatAutomationInvocation(
      "independently check CI every 5 minutes",
    );

    const resolved = resolveChatAutomationIntent({
      deterministicIntent,
      generatedIntent: {
        isAutomation: true,
        confidence: 0.93,
        language: "en",
        name: "Check CI",
        taskPrompt: "Check CI.",
        schedule: { type: "interval", everySeconds: 300 },
        mode: "standalone",
        completionPolicy: { type: "none" },
        missingFields: [],
        needsConfirmation: false,
        reason: null,
      },
      defaultMode: "heartbeat",
      executionScope: deterministicIntent?.executionScope ?? "thread",
    });

    expect(resolved).toMatchObject({
      source: "deterministic",
      mode: "standalone",
      requiresReview: true,
      intent: {
        prompt: "Check CI.",
        executionScope: "standalone",
      },
    });
  });

  it("requires review instead of auto-submitting explicit standalone stop clauses", () => {
    const deterministicIntent = parseChatAutomationIntent(
      "/automation standalone every 5m check CI until it is green",
    );

    const resolved = resolveChatAutomationIntent({
      deterministicIntent,
      generatedIntent: null,
      defaultMode: "heartbeat",
      executionScope: deterministicIntent?.executionScope ?? "thread",
    });

    expect(resolved).toMatchObject({
      mode: "heartbeat",
      requiresReview: true,
      intent: {
        completionPolicy: {
          type: "ai-evaluated",
          stopWhen: "it is green",
        },
      },
    });
  });

  it("keeps generated standalone stop clauses behind review", () => {
    const resolved = resolveChatAutomationIntent({
      deterministicIntent: null,
      generatedIntent: {
        isAutomation: true,
        confidence: 0.95,
        language: "en",
        name: "Check CI",
        taskPrompt: "check CI",
        schedule: { type: "interval", everySeconds: 300 },
        mode: "standalone",
        completionPolicy: {
          type: "ai-evaluated",
          stopWhen: "CI is green",
          confidenceThreshold: DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
        },
        missingFields: [],
        needsConfirmation: false,
        reason: null,
      },
      defaultMode: "heartbeat",
      executionScope: "thread",
    });

    expect(resolved).toMatchObject({
      source: "generated",
      mode: "heartbeat",
      requiresReview: true,
      intent: {
        executionScope: "standalone",
        completionPolicy: {
          type: "ai-evaluated",
          stopWhen: "CI is green",
        },
      },
    });
  });

  it("uses generated intent when local parsing cannot resolve the schedule", () => {
    const resolved = resolveChatAutomationIntent({
      deterministicIntent: null,
      generatedIntent: {
        isAutomation: true,
        confidence: 0.93,
        language: "it",
        name: "Controlla disponibilita",
        taskPrompt: "controlla se il Fitbit nero e disponibile",
        schedule: { type: "interval", everySeconds: 21_600 },
        mode: "heartbeat",
        completionPolicy: { type: "none" },
        missingFields: [],
        needsConfirmation: false,
        reason: null,
      },
      defaultMode: "heartbeat",
      executionScope: "thread",
    });

    expect(resolved).toMatchObject({
      source: "generated",
      mode: "heartbeat",
      // High-confidence (0.93), thread-scoped, no stop policy: must still require human
      // review rather than silently auto-creating a recurring background automation.
      requiresReview: true,
      intent: {
        name: "Controlla disponibilita",
        cadenceLabel: "Every 6h",
      },
    });
  });

  it("always requires review for generated intents, even high-confidence ones with no stop policy", () => {
    // Safety invariant: an LLM-interpreted ("generated") intent must never auto-create.
    // Only deterministic, explicitly-parsed intents may skip the confirmation dialog
    // (e.g. the bounded-fast-loop case covered above, which keeps requiresReview false).
    const resolved = resolveChatAutomationIntent({
      deterministicIntent: null,
      generatedIntent: {
        isAutomation: true,
        confidence: 0.99,
        language: "en",
        name: "Check the dashboard",
        taskPrompt: "check the dashboard",
        schedule: { type: "interval", everySeconds: 21_600 },
        mode: "heartbeat",
        completionPolicy: { type: "none" },
        missingFields: [],
        needsConfirmation: false,
        reason: null,
      },
      defaultMode: "heartbeat",
      executionScope: "thread",
    });

    expect(resolved).toMatchObject({
      source: "generated",
      requiresReview: true,
    });
  });

  it("strips scaffold from generated-only task prompts before saving them", () => {
    const resolved = resolveChatAutomationIntent({
      deterministicIntent: null,
      generatedIntent: {
        isAutomation: true,
        confidence: 0.93,
        language: "en",
        name: "Check website",
        taskPrompt: "Every 6h, check the website for 3 times. Stop when it succeeds.",
        schedule: { type: "interval", everySeconds: 21_600 },
        mode: "heartbeat",
        completionPolicy: {
          type: "ai-evaluated",
          stopWhen: "it succeeds",
          confidenceThreshold: DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
        },
        missingFields: [],
        needsConfirmation: false,
        reason: null,
      },
      defaultMode: "heartbeat",
      executionScope: "thread",
    });

    expect(resolved).toMatchObject({
      source: "generated",
      intent: {
        prompt: "check the website.",
        schedule: { type: "interval", everySeconds: 21_600 },
        maxIterations: 3,
      },
    });
  });

  it("turns generated confirmation results into editable manual drafts", () => {
    const resolved = resolveChatAutomationIntent({
      deterministicIntent: null,
      generatedIntent: {
        isAutomation: true,
        confidence: 0.62,
        language: "en",
        name: "Check thing",
        taskPrompt: "check the thing",
        schedule: null,
        mode: "heartbeat",
        completionPolicy: { type: "none" },
        missingFields: ["schedule"],
        needsConfirmation: true,
        reason: "Missing schedule",
      },
      defaultMode: "heartbeat",
      executionScope: "thread",
    });

    expect(resolved).toMatchObject({
      source: "generated",
      generatedNeedsConfirmation: true,
      intent: { schedule: { type: "manual" } },
    });
  });

  it("keeps generated sub-minute recurring intervals as review-required drafts", () => {
    const resolved = resolveChatAutomationIntent({
      deterministicIntent: null,
      generatedIntent: {
        isAutomation: true,
        confidence: 0.94,
        language: "en",
        name: "Check logs",
        taskPrompt: "check logs",
        schedule: { type: "interval", everySeconds: 15 },
        mode: "heartbeat",
        completionPolicy: { type: "none" },
        missingFields: [],
        needsConfirmation: false,
        reason: null,
      },
      defaultMode: "heartbeat",
      executionScope: "thread",
    });

    expect(resolved).toMatchObject({
      source: "generated",
      generatedNeedsConfirmation: true,
      intent: { schedule: { type: "interval", everySeconds: 15 }, cadenceLabel: "Every 15s" },
    });
  });

  it("rejects low-confidence generated intents", () => {
    expect(
      resolveChatAutomationIntent({
        deterministicIntent: null,
        generatedIntent: {
          isAutomation: true,
          confidence: 0.4,
          language: "en",
          name: "Maybe",
          taskPrompt: "check something",
          schedule: { type: "interval", everySeconds: 3600 },
          mode: "heartbeat",
          completionPolicy: { type: "none" },
          missingFields: [],
          needsConfirmation: false,
          reason: "Ambiguous",
        },
        defaultMode: "heartbeat",
        executionScope: "thread",
      }),
    ).toBeNull();
  });
});
