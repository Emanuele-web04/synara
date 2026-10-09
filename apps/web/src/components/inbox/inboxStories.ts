// FILE: inboxStories.ts
// Purpose: Words for the Inbox recap: a short digest paragraph that tells the day, and
//          compact tiles (a lead, one value, a short detail) for a glance at each part of it.
//          A sentence or tile exists only when its data does.
// Layer: Web inbox logic
// Exports: buildInboxDigest, buildTaskDigest, buildInboxTiles, digest and tile types

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type StatsGetRecapResult,
} from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";
import { pluralize } from "@synara/shared/text";

import type { ProviderUsageProgressTrackProps } from "~/lib/providerUsageDisplay";
import { formatClockDuration } from "../../session-logic";
import { formatCompact, formatNumber } from "@synara/profile-ui/formatting";
import {
  compareWithYesterday,
  modelIconProvider,
  recapTokens,
  type InboxSlotSummary,
  type RecapTotals,
} from "./inbox.logic";

export type InboxIcon =
  | { readonly kind: "provider"; readonly provider: ProviderKind }
  | { readonly kind: "project"; readonly projectId: string };

export type InboxTone = "good" | "bad";

/** A run of digest text; `strong` runs carry the facts and may lead with an icon. */
export type DigestPart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "strong";
      readonly text: string;
      readonly icon?: InboxIcon;
      readonly tone?: InboxTone;
    };

export interface DigestSentence {
  readonly id: "sent" | "work" | "agents" | "yesterday" | "tasks";
  readonly parts: readonly DigestPart[];
}

export type InboxTileId = "model" | "project" | "tokens" | "agents" | "yesterday" | "quota";

export interface InboxTile {
  readonly id: InboxTileId;
  readonly lead: string;
  readonly value: string;
  readonly detail: string;
  readonly detailTone?: InboxTone;
  readonly icon?: InboxIcon;
  /** Quota left, drawn with the shared usage track. */
  readonly track?: ProviderUsageProgressTrackProps;
}

export interface InboxQuotaSummary {
  readonly provider: ProviderKind;
  readonly name: string;
  readonly window: string;
  readonly remainingPercent: number;
  /** "Resets in 3d" style countdown, when the provider reports one. */
  readonly resetText?: string | null;
  readonly track: ProviderUsageProgressTrackProps;
}

export interface InboxRecapInput {
  readonly recap: StatsGetRecapResult;
  readonly previousRecap: StatsGetRecapResult | undefined;
  /** Yesterday's totals up to this same time of day. */
  readonly yesterdaySoFar: RecapTotals | null;
  readonly slots: readonly InboxSlotSummary[];
  /** Today's to-dos (see selectInboxTasks); left out where Tasks is not offered. */
  readonly tasks?: InboxTaskCounts | undefined;
}

export interface InboxTaskCounts {
  readonly open: number;
  readonly done: number;
  readonly overdue: number;
}

function plural(count: number, one: string, many: string): string {
  return `${formatNumber(count)} ${pluralize(count, one, many)}`;
}

function modelName(model: string): string {
  return formatModelDisplayName(model) ?? model;
}

function modelIcon(model: {
  readonly provider: ProviderKind | "unknown";
  readonly model: string;
}): InboxIcon | undefined {
  const provider = modelIconProvider(model.provider, model.model);
  return provider ? { kind: "provider", provider } : undefined;
}

function text(value: string): DigestPart {
  return { kind: "text", text: value };
}

function strong(
  value: string,
  extra: { icon?: InboxIcon | undefined; tone?: InboxTone } = {},
): DigestPart {
  return {
    kind: "strong",
    text: value,
    ...(extra.icon ? { icon: extra.icon } : {}),
    ...(extra.tone ? { tone: extra.tone } : {}),
  };
}

/** "17% more" / "20% fewer" against yesterday; null when there is nothing to compare. */
function changeAmount(
  today: number,
  yesterday: number | null | undefined,
  fewer: string,
): { readonly words: string; readonly tone: InboxTone } | null {
  const change = compareWithYesterday(today, yesterday);
  if (!change || change.trend === "flat") return null;
  const amount = change.label.replace(/^[+-]/, "");
  return change.trend === "up"
    ? { words: `${amount} more`, tone: "good" }
    : { words: `${amount} ${fewer}`, tone: "bad" };
}

/** A model's share of every token in the window; null when there are no tokens to share. */
function tokenShare(
  recap: StatsGetRecapResult,
  model: StatsGetRecapResult["models"][number],
): number | null {
  const tokens = recapTokens(recap.totals);
  return model.tokens > 0 && tokens > 0 ? Math.round((model.tokens / tokens) * 100) : null;
}

/** What the user did on a day: prompts when they sent any, otherwise their agents' turns. */
function activityWords(totals: StatsGetRecapResult["totals"]): string | null {
  if (totals.prompts > 0) return plural(totals.prompts, "prompt", "prompts");
  return totals.turns > 0 ? plural(totals.turns, "turn", "turns") : null;
}

function busiestSlot(slots: readonly InboxSlotSummary[]): InboxSlotSummary | null {
  if (slots.length < 2) return null;
  return slots.reduce((best, slot) => (slot.agentWorkMs > best.agentWorkMs ? slot : best));
}

/** Today's to-dos as a digest sentence of their own, for when there is no recap to tell. */
export function buildTaskDigest(tasks: InboxTaskCounts | undefined): DigestSentence | null {
  const parts = tasks ? taskParts(tasks) : null;
  return parts ? { id: "tasks", parts } : null;
}

/** Today's to-dos in one sentence; nothing when there are none to tell about. */
function taskParts(tasks: InboxTaskCounts): DigestPart[] | null {
  const { open, done, overdue } = tasks;
  if (open === 0 && done === 0) return null;
  if (open === 0) {
    return [
      text(done === 1 ? "You finished your " : "You finished all "),
      strong(plural(done, "task", "tasks")),
      text(" for today."),
    ];
  }
  return [
    ...(done > 0
      ? [
          text("You finished "),
          strong(plural(done, "task", "tasks")),
          text(" today, "),
          strong(`${formatNumber(open)} to go`),
        ]
      : [text("You have "), strong(plural(open, "task", "tasks")), text(" to do today")]),
    ...(overdue > 0
      ? [text(", "), strong(`${formatNumber(overdue)} overdue`, { tone: "bad" })]
      : []),
    text("."),
  ];
}

/**
 * The day in two or three sentences: what the user sent, where the work went and which
 * model carried it, how long the agents ran. On a day with nothing yet, yesterday instead.
 * Today's to-dos close it. Empty when there is nothing to tell.
 */
export function buildInboxDigest(input: InboxRecapInput): DigestSentence[] {
  const { recap, previousRecap, yesterdaySoFar, slots, tasks } = input;
  const totals = recap.totals;
  const sentences: DigestSentence[] = [];
  const push = (id: DigestSentence["id"], parts: readonly DigestPart[]) => {
    sentences.push({ id, parts });
  };

  if (totals.prompts > 0) {
    const change = changeAmount(totals.prompts, yesterdaySoFar?.prompts, "fewer");
    push("sent", [
      text("You sent "),
      strong(plural(totals.prompts, "prompt", "prompts")),
      text(" across "),
      strong(plural(totals.chats, "chat", "chats")),
      ...(change
        ? [
            text(", "),
            strong(change.words, { tone: change.tone }),
            text(" than this time yesterday."),
          ]
        : [text(".")]),
    ]);
  } else if (totals.turns > 0) {
    push("sent", [
      text("Your automations and agents ran "),
      strong(plural(totals.turns, "turn", "turns")),
      text(" so far today."),
    ]);
  }

  const [topProject] = recap.projects;
  const [bestModel, nextModel] = recap.models;
  if (topProject || bestModel) {
    const parts: DigestPart[] = [];
    if (topProject) {
      parts.push(
        text("Most of it went into "),
        strong(topProject.title, { icon: { kind: "project", projectId: topProject.projectId } }),
      );
    }
    if (bestModel) {
      const model = strong(modelName(bestModel.model), { icon: modelIcon(bestModel) });
      if (topProject) {
        parts.push(text(", with "), model);
      } else {
        parts.push(model);
      }
      const share = tokenShare(recap, bestModel);
      if (share !== null && share < 100) {
        parts.push(text(" carrying "), strong(`${share}%`), text(" of the tokens"));
        if (nextModel) {
          // "The rest" is only true when a second model is all that is left.
          const onlyTwo = recap.models.length === 2;
          parts.push(
            text(onlyTwo ? " and " : ", ahead of "),
            strong(modelName(nextModel.model), { icon: modelIcon(nextModel) }),
            ...(onlyTwo ? [text(" the rest")] : []),
          );
        }
      } else if (nextModel) {
        parts.push(text(topProject ? " doing most of the work" : " did most of the work"));
      } else {
        parts.push(text(topProject ? " doing the work" : " did all the work"));
      }
    }
    parts.push(text("."));
    push("work", parts);
  }

  if (totals.agentWorkMs >= 1_000) {
    const busiest = busiestSlot(slots);
    push("agents", [
      text("Your agents ran for "),
      strong(formatClockDuration(totals.agentWorkMs)),
      ...(busiest ? [text(`, mostly in the ${busiest.label.toLowerCase()}`)] : []),
      ...(totals.failedTurns > 0
        ? [
            text(", and "),
            strong(`${plural(totals.failedTurns, "turn", "turns")} failed`, { tone: "bad" }),
          ]
        : []),
      text("."),
    ]);
  }

  if (sentences.length === 0 && previousRecap) {
    const previous = previousRecap.totals;
    const previousTokens = recapTokens(previous);
    if (previous.prompts > 0 || previousTokens > 0) {
      const [previousBest] = previousRecap.models;
      push("yesterday", [
        ...(previous.prompts > 0
          ? [
              text("Nothing ran yet today. Yesterday you sent "),
              strong(plural(previous.prompts, "prompt", "prompts")),
              text(" and used "),
            ]
          : [text("Nothing ran yet today. Yesterday your agents used ")]),
        strong(`${formatCompact(previousTokens)} tokens`),
        ...(previousBest
          ? [
              text(", mostly with "),
              strong(modelName(previousBest.model), { icon: modelIcon(previousBest) }),
            ]
          : []),
        text("."),
      ]);
    }
  }

  const tasksToday = buildTaskDigest(tasks);
  if (tasksToday) sentences.push(tasksToday);

  return sentences;
}

/** The compact tiles under the digest, in reading order. Details stay one short line. */
export function buildInboxTiles(
  input: InboxRecapInput & { readonly quota: readonly InboxQuotaSummary[] },
): InboxTile[] {
  const { recap, previousRecap, yesterdaySoFar, slots } = input;
  const totals = recap.totals;
  const tokens = recapTokens(totals);
  const tiles: InboxTile[] = [];

  const [bestModel] = recap.models;
  if (bestModel) {
    const share = tokenShare(recap, bestModel);
    const icon = modelIcon(bestModel);
    tiles.push({
      id: "model",
      lead: "Your best model was",
      value: modelName(bestModel.model),
      detail:
        share !== null
          ? `${share}% of tokens, ${plural(bestModel.turns, "turn", "turns")}`
          : `${plural(bestModel.turns, "turn", "turns")}${
              bestModel.provider === "unknown"
                ? ""
                : ` through ${PROVIDER_DISPLAY_NAMES[bestModel.provider]}`
            }`,
      ...(icon ? { icon } : {}),
    });
  }

  const [topProject, nextProject] = recap.projects;
  if (topProject) {
    tiles.push({
      id: "project",
      lead: "You worked most on",
      value: topProject.title,
      detail: `${plural(topProject.prompts, "prompt", "prompts")}${
        nextProject ? `, then ${nextProject.title}` : `, ${formatCompact(topProject.tokens)} tokens`
      }`,
      icon: { kind: "project", projectId: topProject.projectId },
    });
  }

  if (tokens > 0) {
    const change = changeAmount(tokens, yesterdaySoFar?.tokens, "less");
    tiles.push({
      id: "tokens",
      lead: "You used",
      value: `${formatCompact(tokens)} tokens`,
      detail: change ? `${change.words} than this time yesterday` : "Cache reads included",
      ...(change?.tone === "good" ? { detailTone: "good" as const } : {}),
    });
  }

  if (totals.agentWorkMs >= 1_000) {
    const busiest = busiestSlot(slots);
    const failed = totals.failedTurns > 0 ? `${formatNumber(totals.failedTurns)} failed` : null;
    tiles.push({
      id: "agents",
      lead: "Your agents worked for",
      value: formatClockDuration(totals.agentWorkMs),
      detail:
        [busiest ? `Mostly ${busiest.label.toLowerCase()}` : null, failed]
          .filter(Boolean)
          .join(", ") || "Nothing failed",
      ...(failed ? { detailTone: "bad" as const } : {}),
    });
  }

  if (previousRecap) {
    const previous = previousRecap.totals;
    const previousTokens = recapTokens(previous);
    const [previousBest] = previousRecap.models;
    if (previousTokens > 0 || previous.prompts > 0) {
      const icon = previousBest ? modelIcon(previousBest) : undefined;
      const activity = activityWords(previous);
      const mostly = previousBest ? modelName(previousBest.model) : null;
      tiles.push({
        id: "yesterday",
        lead: "Yesterday you used",
        value: `${formatCompact(previousTokens)} tokens`,
        detail:
          activity && mostly
            ? `${activity}, mostly ${mostly}`
            : (activity ?? (mostly ? `Mostly ${mostly}` : "Cache reads included")),
        ...(icon ? { icon } : {}),
      });
    }
  }

  const [tightest] = input.quota.toSorted(
    (left, right) => left.remainingPercent - right.remainingPercent,
  );
  if (tightest) {
    tiles.push({
      id: "quota",
      lead: `Left on ${tightest.name}, ${tightest.window.toLowerCase()}`,
      value: `${Math.round(tightest.remainingPercent)}%`,
      detail: tightest.resetText ?? "Your tightest limit",
      icon: { kind: "provider", provider: tightest.provider },
      track: tightest.track,
    });
  }

  return tiles;
}
