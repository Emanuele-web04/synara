// FILE: automationIntent.test.ts
// Purpose: Locks down chat-composer automation intent parsing.
// Layer: Web lib test
// Depends on: parseChatAutomationIntent and cadence formatting.

import { DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  extractChatAutomationInvocation,
  formatAutomationIntentCadence,
  parseChatAutomationInvocation,
  parseChatAutomationIntent,
  resolveChatAutomationIntent,
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

  it("extracts English stop clauses into first-class completion policies", () => {
    expect(
      parseChatAutomationInvocation(
        "every 3 min watch codex-bot. Stop when codex-bot says the PR is ready to merge. If there are actionable issues, fix them and keep monitoring.",
      ),
    ).toMatchObject({
      prompt:
        "watch codex-bot. If there are actionable issues, fix them and keep monitoring.",
      completionPolicy: {
        type: "ai-evaluated",
        stopWhen: "codex-bot says the PR is ready to merge",
        confidenceThreshold: DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
      },
    });

    expect(parseChatAutomationInvocation("every 5 min keep monitoring until CI is green"))
      .toMatchObject({
        prompt: "keep monitoring",
        completionPolicy: {
          type: "ai-evaluated",
          stopWhen: "CI is green",
        },
      });

    expect(parseChatAutomationInvocation("every 10 min check the PR; if there are no issues, stop"))
      .toMatchObject({
        completionPolicy: {
          type: "ai-evaluated",
          stopWhen: "there are no issues",
        },
      });
  });

  it("extracts Italian stop clauses into first-class completion policies", () => {
    expect(parseChatAutomationInvocation("ogni 5 minuti controlla la PR finché è pronta"))
      .toMatchObject({
        completionPolicy: {
          type: "ai-evaluated",
          stopWhen: "è pronta",
        },
      });

    expect(parseChatAutomationInvocation("ogni 5 minuti controlla la PR. Quando è pronta, fermati"))
      .toMatchObject({
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

  it("prefers deterministic intent so obvious requests do not need AI generation", () => {
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
        mode: "standalone",
        completionPolicy: { type: "none" },
        missingFields: [],
        needsConfirmation: false,
        reason: null,
      },
      isServerThread: true,
    });

    expect(resolved).toMatchObject({
      source: "deterministic",
      mode: "heartbeat",
      intent: {
        prompt: "check the website",
        schedule: { type: "interval", everySeconds: 21_600 },
      },
    });
  });

  it("requires review instead of auto-submitting stop clauses from standalone contexts", () => {
    const deterministicIntent = parseChatAutomationIntent(
      "/automation every 5m check CI until it is green",
    );

    const resolved = resolveChatAutomationIntent({
      deterministicIntent,
      generatedIntent: null,
      isServerThread: false,
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

  it("converts generated standalone stop clauses to heartbeat drafts", () => {
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
      isServerThread: true,
    });

    expect(resolved).toMatchObject({
      source: "generated",
      mode: "heartbeat",
      requiresReview: true,
      intent: {
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
      isServerThread: true,
    });

    expect(resolved).toMatchObject({
      source: "generated",
      mode: "heartbeat",
      intent: {
        name: "Controlla disponibilita",
        cadenceLabel: "Every 6h",
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
      isServerThread: true,
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
      isServerThread: true,
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
        isServerThread: true,
      }),
    ).toBeNull();
  });
});
