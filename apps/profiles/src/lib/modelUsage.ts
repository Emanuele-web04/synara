// The profile's model usage grouped the way people think of models: one entry per provider and
// model, summing the reasoning levels it ran at (the API reports each level separately), named
// with the desktop's display names ("gpt-6-astra" → "GPT-6 Astra").

import { humanizeModelSlug } from "@synara/shared/modelName";
import type { PublicProfileModelUsage } from "./publicProfile";

export type ModelUsageGroup = {
  provider: string;
  model: string;
  displayName: string;
  tokens: number;
  turns: number;
  /** Reasoning levels it ran at, most used first. */
  reasoning: string[];
};

/** A provider's dated snapshot suffix ("claude-haiku-4-5-20251001"): the same model to a reader. */
const BUILD_DATE_SUFFIX = /[-_]\d{8}$/u;

export function groupModelUsage(rows: readonly PublicProfileModelUsage[]): ModelUsageGroup[] {
  const groups = new Map<string, ModelUsageGroup & { reasoningTokens: Map<string, number> }>();
  for (const row of rows) {
    const model = row.model.replace(BUILD_DATE_SUFFIX, "");
    const key = `${row.provider}\u0000${model.toLowerCase()}`;
    const group = groups.get(key) ?? {
      provider: row.provider,
      model,
      displayName: humanizeModelSlug(model),
      tokens: 0,
      turns: 0,
      reasoning: [],
      reasoningTokens: new Map<string, number>(),
    };
    group.tokens += row.tokens;
    group.turns += row.turns;
    if (row.reasoning) {
      group.reasoningTokens.set(
        row.reasoning,
        (group.reasoningTokens.get(row.reasoning) ?? 0) + row.tokens,
      );
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ reasoningTokens, ...group }) => ({
      ...group,
      reasoning: [...reasoningTokens.entries()]
        .toSorted((left, right) => right[1] - left[1])
        .map(([level]) => level),
    }))
    .toSorted((left, right) => right.tokens - left.tokens);
}
