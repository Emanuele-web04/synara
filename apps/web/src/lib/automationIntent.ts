// FILE: automationIntent.ts
// Purpose: Detects when a normal chat prompt is actually asking Synara to create an automation.
// Layer: Web composer helper
// Exports: automation intent parsers, resolver, and cadence/name formatters.
// Depends on: AutomationSchedule contract shared with the automation API.

import type {
  AutomationCompletionPolicy,
  AutomationMode,
  AutomationSchedule,
  ServerGenerateAutomationIntentResult,
} from "@t3tools/contracts";

import {
  completionPolicyFromStopWhen,
  modeForCompletionPolicy,
  requiresCompletionPolicyReview,
} from "./automationCompletionPolicy";

export interface ChatAutomationIntent {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: AutomationSchedule;
  readonly cadenceLabel: string;
  readonly completionPolicy: AutomationCompletionPolicy;
}

export interface ResolvedChatAutomationIntent {
  readonly intent: ChatAutomationIntent;
  readonly mode: AutomationMode;
  readonly source: "deterministic" | "generated";
  readonly requiresReview: boolean;
  readonly generatedConfidence: number | null;
  readonly generatedNeedsConfirmation: boolean;
  readonly reason: string | null;
}

interface ParsedSchedule {
  readonly schedule: AutomationSchedule;
  readonly cadenceLabel: string;
}

const DEFAULT_DAILY_TIME = "09:00";
const GENERATED_INTENT_CONFIDENCE_THRESHOLD = 0.75;
const MAX_NAME_LENGTH = 120;
const CRON_FIELD_PATTERN = "[*/0-9,-]+";

const WEEKDAY_BY_TOKEN: Record<string, number> = {
  sunday: 0,
  sun: 0,
  domenica: 0,
  monday: 1,
  mon: 1,
  lunedi: 1,
  tuesday: 2,
  tue: 2,
  martedi: 2,
  wednesday: 3,
  wed: 3,
  mercoledi: 3,
  thursday: 4,
  thu: 4,
  giovedi: 4,
  friday: 5,
  fri: 5,
  venerdi: 5,
  saturday: 6,
  sat: 6,
  sabato: 6,
};

const WEEKDAY_STRIP_PATTERN = [
  ...Object.keys(WEEKDAY_BY_TOKEN),
  "lunedi",
  "lunedì",
  "martedi",
  "martedì",
  "mercoledi",
  "mercoledì",
  "giovedi",
  "giovedì",
  "venerdi",
  "venerdì",
].join("|");

const TIME_PATTERN = "((?:[01]?\\d|2[0-3])(?::[0-5]\\d)?\\s*(?:am|pm)?)";
const INTERVAL_PATTERN =
  "(\\d{1,4})\\s*(seconds|second|secs|sec|secondi|secondo|minutes|minute|mins|minuti|minuto|min|hours|hour|hrs|hr|ore|ora|days|day|giorni|giorno|s|m|h|d|g)";

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSearchText(value: string): string {
  return normalizeInlineText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

interface ParsedStopClause {
  readonly stopWhen: string;
  readonly textWithoutStopClause: string;
}

function extractStopClause(value: string): ParsedStopClause | null {
  const patterns: readonly RegExp[] = [
    /\bstop\s+when\s+(.+?)(?=(?:[.!?]\s+|$))/i,
    /\buntil\s+(.+?)(?=(?:[.!?]\s+|$))/i,
    /\bkeep\s+monitoring\s+until\s+(.+?)(?=(?:[.!?]\s+|$))/i,
    /\bif\s+(.+?),\s*stop\b/i,
    /\bquando\s+(.+?),\s*fermati\b/i,
    /\bfinch[eé]\s+(.+?)(?=(?:[.!?]\s+|$))/i,
    /\bfino\s+a\s+quando\s+(.+?)(?=(?:[.!?]\s+|$))/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    const stopWhen = match?.[1]?.trim().replace(/[.!?]+$/g, "").trim();
    if (!match || !stopWhen) {
      continue;
    }
    const textWithoutStopClause = normalizeInlineText(
      `${value.slice(0, match.index)} ${value.slice(match.index + match[0].length)}`,
    )
      .replace(/([.!?])\s+[.!?]/g, "$1")
      .replace(/^(?:and|then|e|poi)\s+/i, "");
    return {
      stopWhen,
      textWithoutStopClause,
    };
  }
  return null;
}

export function extractChatAutomationInvocation(value: string): string | null {
  const text = normalizeInlineText(value);
  if (!text) {
    return null;
  }

  const slashMatch = /^\/automation(?:\s+([\s\S]*))?$/i.exec(text);
  if (slashMatch) {
    return normalizeInlineText(slashMatch[1] ?? "");
  }

  const withoutInlineMarker = text.replace(
    /(^|\s)(?:@automation(?::)?|\/automation)(?=\s|$)/i,
    " ",
  );
  if (withoutInlineMarker !== text) {
    return normalizeInlineText(withoutInlineMarker);
  }

  return null;
}

function parseTimeOfDay(value: string | undefined): string | null {
  const match = /^([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?$/i.exec(value?.trim() ?? "");
  if (!match) {
    return null;
  }
  const meridiem = match[3]?.toLowerCase();
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (Number.isNaN(hour) || (meridiem && hour > 12)) {
    return null;
  }
  const safeHour =
    meridiem === "pm" && hour < 12 ? hour + 12 : meridiem === "am" && hour === 12 ? 0 : hour;
  const safeMinute = Number.isNaN(minute) ? 0 : Math.min(59, Math.max(0, minute));
  return `${String(safeHour).padStart(2, "0")}:${String(safeMinute).padStart(2, "0")}`;
}

function intervalUnitToSeconds(unit: string): number {
  if (
    unit === "s" ||
    unit === "sec" ||
    unit === "secs" ||
    unit === "second" ||
    unit === "seconds" ||
    unit === "secondo" ||
    unit === "secondi"
  ) {
    return 1;
  }
  if (
    unit === "m" ||
    unit === "min" ||
    unit === "mins" ||
    unit === "minute" ||
    unit === "minutes" ||
    unit === "minuto" ||
    unit === "minuti"
  ) {
    return 60;
  }
  if (
    unit === "h" ||
    unit === "hr" ||
    unit === "hrs" ||
    unit === "hour" ||
    unit === "hours" ||
    unit === "ora" ||
    unit === "ore"
  ) {
    return 3600;
  }
  return 86_400;
}

function intervalUnitLabel(unit: string): "s" | "m" | "h" | "d" {
  const seconds = intervalUnitToSeconds(unit);
  if (seconds === 1) return "s";
  if (seconds === 60) return "m";
  if (seconds === 3600) return "h";
  return "d";
}

export function formatAutomationIntentCadence(schedule: AutomationSchedule): string {
  if (schedule.type === "interval") {
    const seconds = schedule.everySeconds;
    if (seconds % 86_400 === 0) return `Every ${seconds / 86_400}d`;
    if (seconds % 3_600 === 0) return `Every ${seconds / 3_600}h`;
    if (seconds % 60 === 0) return `Every ${seconds / 60}m`;
    return `Every ${seconds}s`;
  }
  if (schedule.type === "once") {
    return `Once at ${new Date(schedule.runAt).toLocaleString()}`;
  }
  if (schedule.type === "cron") {
    return `Cron ${schedule.expression}`;
  }
  if (schedule.type === "daily") {
    return `Daily at ${schedule.timeOfDay}`;
  }
  if (schedule.type === "weekdays") {
    return `Weekdays at ${schedule.timeOfDay}`;
  }
  if (schedule.type === "weekly") {
    return `Weekly at ${schedule.timeOfDay}`;
  }
  return "Manual";
}

function parseIntervalSchedule(searchText: string): ParsedSchedule | null {
  const match =
    searchText.match(new RegExp(`\\b(?:every|each)\\s+${INTERVAL_PATTERN}\\b`)) ??
    searchText.match(new RegExp(`\\bogni\\s+${INTERVAL_PATTERN}\\b`));
  if (!match) {
    return null;
  }

  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2] ?? "m";
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const everySeconds = amount * intervalUnitToSeconds(unit);

  const schedule = {
    type: "interval",
    everySeconds,
  } as const;
  return {
    schedule,
    cadenceLabel: `Every ${amount}${intervalUnitLabel(unit)}`,
  };
}

function parseOnceSchedule(searchText: string, nowIso: string): ParsedSchedule | null {
  const match =
    searchText.match(new RegExp(`\\bin\\s+${INTERVAL_PATTERN}\\b`)) ??
    searchText.match(new RegExp(`\\b(?:tra|fra)\\s+${INTERVAL_PATTERN}\\b`));
  if (!match) {
    return null;
  }

  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2] ?? "m";
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const delaySeconds = amount * intervalUnitToSeconds(unit);
  if (delaySeconds < 5) {
    return null;
  }
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    return null;
  }
  const runAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
  return {
    schedule: { type: "once", runAt },
    cadenceLabel: `In ${amount}${intervalUnitLabel(unit)}`,
  };
}

function parseCronSchedule(searchText: string): ParsedSchedule | null {
  const match = searchText.match(
    new RegExp(
      `\\bcron\\s+(${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN})(?=\\s|$)`,
    ),
  );
  if (!match?.[1]) {
    return null;
  }
  const expression = match[1].trim();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    schedule: { type: "cron", expression, timezone },
    cadenceLabel: `Cron ${expression}`,
  };
}

function parseDailySchedule(searchText: string): ParsedSchedule | null {
  const timedDailyMatch =
    searchText.match(new RegExp(`\\b(?:daily|every day)\\s+at\\s+${TIME_PATTERN}\\b`)) ??
    searchText.match(
      new RegExp(`\\b(?:ogni giorno|tutti i giorni)\\s+(?:alle|a)\\s+${TIME_PATTERN}\\b`),
    );
  if (timedDailyMatch) {
    const timeOfDay = parseTimeOfDay(timedDailyMatch[1]);
    return timeOfDay
      ? {
          schedule: { type: "daily", timeOfDay },
          cadenceLabel: `Daily at ${timeOfDay}`,
        }
      : null;
  }

  if (
    /\b(?:daily|every day)\s+at\b/.test(searchText) ||
    /\b(?:ogni giorno|tutti i giorni)\s+(?:alle|a)\b/.test(searchText)
  ) {
    return null;
  }

  const dailyMatch =
    searchText.match(/\b(?:daily|every day)\b/) ??
    searchText.match(/\b(?:ogni giorno|tutti i giorni)\b/);
  if (!dailyMatch) {
    return null;
  }

  const timeOfDay = DEFAULT_DAILY_TIME;
  return {
    schedule: { type: "daily", timeOfDay },
    cadenceLabel: `Daily at ${timeOfDay}`,
  };
}

function parseWeekdaysSchedule(searchText: string): ParsedSchedule | null {
  const timedWeekdaysMatch =
    searchText.match(
      new RegExp(`\\b(?:weekdays|every weekday|workdays)\\s+at\\s+${TIME_PATTERN}\\b`),
    ) ??
    searchText.match(
      new RegExp(
        `\\b(?:giorni lavorativi|ogni giorno lavorativo)\\s+(?:alle|a)\\s+${TIME_PATTERN}\\b`,
      ),
    );
  if (timedWeekdaysMatch) {
    const timeOfDay = parseTimeOfDay(timedWeekdaysMatch[1]);
    return timeOfDay
      ? {
          schedule: { type: "weekdays", timeOfDay },
          cadenceLabel: `Weekdays at ${timeOfDay}`,
        }
      : null;
  }

  if (
    /\b(?:weekdays|every weekday|workdays)\s+at\b/.test(searchText) ||
    /\b(?:giorni lavorativi|ogni giorno lavorativo)\s+(?:alle|a)\b/.test(searchText)
  ) {
    return null;
  }

  const weekdaysMatch =
    searchText.match(/\b(?:weekdays|every weekday|workdays)\b/) ??
    searchText.match(/\b(?:giorni lavorativi|ogni giorno lavorativo)\b/);
  if (!weekdaysMatch) {
    return null;
  }

  const timeOfDay = DEFAULT_DAILY_TIME;
  return {
    schedule: { type: "weekdays", timeOfDay },
    cadenceLabel: `Weekdays at ${timeOfDay}`,
  };
}

function parseWeeklySchedule(searchText: string): ParsedSchedule | null {
  const weekdayTokens = Object.keys(WEEKDAY_BY_TOKEN).join("|");
  const timedWeeklyMatch =
    searchText.match(new RegExp(`\\bevery\\s+(${weekdayTokens})\\s+at\\s+${TIME_PATTERN}\\b`)) ??
    searchText.match(
      new RegExp(`\\bogni\\s+(${weekdayTokens})\\s+(?:alle|a)\\s+${TIME_PATTERN}\\b`),
    );
  if (timedWeeklyMatch) {
    const dayOfWeek = WEEKDAY_BY_TOKEN[timedWeeklyMatch[1] ?? ""];
    const timeOfDay = parseTimeOfDay(timedWeeklyMatch[2]);
    return dayOfWeek !== undefined && timeOfDay
      ? {
          schedule: { type: "weekly", dayOfWeek, timeOfDay },
          cadenceLabel: `Weekly at ${timeOfDay}`,
        }
      : null;
  }

  if (
    new RegExp(`\\bevery\\s+(?:${weekdayTokens})\\s+at\\b`).test(searchText) ||
    new RegExp(`\\bogni\\s+(?:${weekdayTokens})\\s+(?:alle|a)\\b`).test(searchText)
  ) {
    return null;
  }

  const weeklyMatch =
    searchText.match(new RegExp(`\\bevery\\s+(${weekdayTokens})\\b`)) ??
    searchText.match(new RegExp(`\\bogni\\s+(${weekdayTokens})\\b`));
  if (!weeklyMatch) {
    return null;
  }

  const dayOfWeek = WEEKDAY_BY_TOKEN[weeklyMatch[1] ?? ""];
  if (dayOfWeek === undefined) {
    return null;
  }

  const timeOfDay = DEFAULT_DAILY_TIME;
  return {
    schedule: { type: "weekly", dayOfWeek, timeOfDay },
    cadenceLabel: `Weekly at ${timeOfDay}`,
  };
}

function parseSchedule(searchText: string, nowIso: string): ParsedSchedule | null {
  if (/\b(?:between|around|circa|verso)\b/.test(searchText)) {
    return null;
  }
  return (
    parseCronSchedule(searchText) ??
    parseOnceSchedule(searchText, nowIso) ??
    parseIntervalSchedule(searchText) ??
    parseWeekdaysSchedule(searchText) ??
    parseWeeklySchedule(searchText) ??
    parseDailySchedule(searchText)
  );
}

function stripAutomationScaffold(value: string): string {
  let cleaned = normalizeInlineText(value);
  cleaned = cleaned
    .replace(
      /^(?:please\s+)?(?:make|create|set up|setup|add|start|build)\s+(?:an?\s+)?automation\s*(?:where|that|to|which)?\s*/i,
      "",
    )
    .replace(
      /^(?:please\s+)?(?:crea|creare|aggiungi|imposta|fai)\s+(?:un[' ]?)?(?:automazione|task|controllo|monitoraggio)\s*(?:che|per|dove)?\s*/i,
      "",
    )
    .replace(
      /^(?:please\s+)?schedule\s+(?:an?\s+)?(?:automation|task|job|check|monitor|reminder)\s*(?:to|that)?\s*/i,
      "",
    )
    .replace(/^(?:please\s+)?automate\s+(?:this|that|it)?\s*/i, "")
    .replace(/^(?:where|that|to|che|per|dove)\s+/i, "");

  cleaned = cleaned
    .replace(
      new RegExp(
        `\\b(?:you\\s+)?wake\\s+up\\s+every\\s+${INTERVAL_PATTERN}\\b\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b(?:you\\s+)?run\\s+(?:it|this)?\\s*every\\s+${INTERVAL_PATTERN}\\b\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(new RegExp(`\\bevery\\s+${INTERVAL_PATTERN}\\b\\s*(?:and|to|then|,)?\\s*`, "i"), "")
    .replace(new RegExp(`\\bogni\\s+${INTERVAL_PATTERN}\\b\\s*(?:e|poi|per|,)?\\s*`, "i"), "")
    .replace(new RegExp(`\\bin\\s+${INTERVAL_PATTERN}\\b\\s*(?:and|to|then|,)?\\s*`, "i"), "")
    .replace(
      new RegExp(`\\b(?:tra|fra)\\s+${INTERVAL_PATTERN}\\b\\s*(?:e|poi|per|,)?\\s*`, "i"),
      "",
    )
    .replace(
      new RegExp(
        `\\bcron\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b(?:daily|every day)(?:\\s+(?:at|around)\\s+${TIME_PATTERN})?\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b(?:ogni giorno|tutti i giorni)(?:\\s+(?:alle|a)\\s+${TIME_PATTERN})?\\s*(?:e|poi|per|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b(?:weekdays|every weekday|workdays)(?:\\s+at\\s+${TIME_PATTERN})?\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b(?:giorni lavorativi|ogni giorno lavorativo)(?:\\s+(?:alle|a)\\s+${TIME_PATTERN})?\\s*(?:e|poi|per|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\bevery\\s+(?:${WEEKDAY_STRIP_PATTERN})(?:\\s+at\\s+${TIME_PATTERN})?\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\bogni\\s+(?:${WEEKDAY_STRIP_PATTERN})(?:\\s+(?:alle|a)\\s+${TIME_PATTERN})?\\s*(?:e|poi|per|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(/^(?:please)\s+/i, "")
    .replace(/^(?:and|then|to|e|poi|che|di|per)\s+/i, "");

  return normalizeInlineText(cleaned);
}

function stripUrls(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, " ");
}

function truncateName(value: string): string {
  const normalized = normalizeInlineText(value);
  if (normalized.length <= MAX_NAME_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}...`;
}

function sentenceCase(value: string): string {
  const trimmed = normalizeInlineText(value);
  if (!trimmed) {
    return "Chat automation";
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function deriveAutomationIntentName(prompt: string): string {
  const withoutUrls = stripUrls(prompt);
  const availabilitySubject = withoutUrls.match(
    /\b(?:check|verify|monitor|watch|controlla|verifica|monitora)\s+(?:if|whether|se)?\s*(.+?)\s+(?:is|are|e|available|disponibile|disponibili|in stock)\b/i,
  );
  if (availabilitySubject?.[1]) {
    return truncateName(`Check ${sentenceCase(availabilitySubject[1])} availability`);
  }

  const actionSeed = withoutUrls.replace(
    /^(?:please\s+)?(?:check|verify|monitor|watch|notify|remind|tell me|controlla|verifica|monitora|avvisami|ricordami)\s+(?:me\s+)?/i,
    "",
  );
  return truncateName(sentenceCase(actionSeed));
}

export function parseChatAutomationInvocation(
  invocation: string,
  options: { readonly nowIso?: string } = {},
): ChatAutomationIntent | null {
  const normalizedInvocation = normalizeInlineText(invocation);
  if (!normalizedInvocation) {
    return null;
  }

  const searchText = normalizeSearchText(normalizedInvocation);
  const parsedSchedule = parseSchedule(searchText, options.nowIso ?? new Date().toISOString());
  if (!parsedSchedule) {
    return null;
  }

  const prompt = stripAutomationScaffold(normalizedInvocation);
  if (!prompt) {
    return null;
  }
  const stopClause = extractStopClause(prompt);
  const taskPrompt = stopClause?.textWithoutStopClause
    ? stripAutomationScaffold(stopClause.textWithoutStopClause)
    : prompt;
  if (!taskPrompt) {
    return null;
  }
  return {
    name: deriveAutomationIntentName(taskPrompt),
    prompt: taskPrompt,
    schedule: parsedSchedule.schedule,
    cadenceLabel: parsedSchedule.cadenceLabel,
    completionPolicy: completionPolicyFromStopWhen(stopClause?.stopWhen ?? ""),
  };
}

// Parses only explicit scheduled intents so regular automation questions keep going to the model.
export function parseChatAutomationIntent(
  value: string,
  options: { readonly nowIso?: string } = {},
): ChatAutomationIntent | null {
  const invocation = extractChatAutomationInvocation(value);
  if (invocation === null) {
    return null;
  }
  return parseChatAutomationInvocation(invocation, options);
}

function generatedAutomationIntentToChatIntent(
  generatedIntent: ServerGenerateAutomationIntentResult | null,
): ChatAutomationIntent | null {
  if (generatedIntent?.isAutomation !== true || generatedIntent.taskPrompt === null) {
    return null;
  }

  if (
    generatedIntent.confidence < GENERATED_INTENT_CONFIDENCE_THRESHOLD &&
    !generatedIntent.needsConfirmation
  ) {
    return null;
  }

  const schedule = generatedIntent.schedule ?? { type: "manual" as const };
  return {
    name: generatedIntent.name ?? deriveAutomationIntentName(generatedIntent.taskPrompt),
    prompt: generatedIntent.taskPrompt,
    schedule,
    cadenceLabel: formatAutomationIntentCadence(schedule),
    completionPolicy: generatedIntent.completionPolicy ?? { type: "none" },
  };
}

export function resolveChatAutomationIntent(input: {
  readonly deterministicIntent: ChatAutomationIntent | null;
  readonly generatedIntent: ServerGenerateAutomationIntentResult | null;
  readonly isServerThread: boolean;
}): ResolvedChatAutomationIntent | null {
  const defaultMode: AutomationMode = input.isServerThread ? "heartbeat" : "standalone";
  if (input.deterministicIntent) {
    const mode = modeForCompletionPolicy(defaultMode, input.deterministicIntent.completionPolicy);
    return {
      intent: input.deterministicIntent,
      mode,
      source: "deterministic",
      requiresReview: requiresCompletionPolicyReview(
        defaultMode,
        input.deterministicIntent.completionPolicy,
      ),
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      reason: null,
    };
  }

  const generatedIntent = generatedAutomationIntentToChatIntent(input.generatedIntent);
  if (!generatedIntent) {
    return null;
  }

  const generatedSchedule = input.generatedIntent?.schedule;
  const fastRecurringInterval =
    generatedSchedule?.type === "interval" && generatedSchedule.everySeconds < 60;

  const requestedMode = input.isServerThread
    ? (input.generatedIntent?.mode ?? "heartbeat")
    : "standalone";
  const mode = modeForCompletionPolicy(requestedMode, generatedIntent.completionPolicy);
  return {
    intent: generatedIntent,
    mode,
    source: "generated",
    requiresReview: requiresCompletionPolicyReview(
      requestedMode,
      generatedIntent.completionPolicy,
    ),
    generatedConfidence: input.generatedIntent?.confidence ?? null,
    generatedNeedsConfirmation:
      (input.generatedIntent?.needsConfirmation ?? false) || fastRecurringInterval,
    reason: input.generatedIntent?.reason ?? null,
  };
}
