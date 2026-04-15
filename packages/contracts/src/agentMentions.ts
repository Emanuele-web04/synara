/**
 * Agent Mentions - @alias(task) syntax for subagent delegation
 *
 * Provides aliases for calling subagents with specific models.
 * Usage: @spark(do this task) or @mini(handle this)
 */

import type { ModelSlug } from "./model";

// ── Types ─────────────────────────────────────────────────────────────

export interface AgentAliasDefinition {
  readonly model: ModelSlug;
  readonly displayName: string;
  readonly color: string; // Tailwind color class suffix (e.g., "violet", "teal", "amber")
}

export interface ResolvedAgentAlias {
  readonly alias: string;
  readonly model: ModelSlug;
  readonly displayName: string;
  readonly color: string;
}

// ── Alias Definitions ─────────────────────────────────────────────────

/**
 * Agent aliases for the @agent(task) mention syntax.
 * Maps short names to model slugs for subagent delegation.
 */
export const AGENT_MENTION_ALIASES: Record<string, AgentAliasDefinition> = {
  // GPT-5.4 family - violet/purple
  "5.4": { model: "gpt-5.4", displayName: "GPT-5.4", color: "violet" },
  mini: { model: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", color: "fuchsia" },
  "5.4-mini": { model: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", color: "fuchsia" },
  // GPT-5.3 family - teal/cyan
  codex: { model: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", color: "teal" },
  "5.3": { model: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", color: "teal" },
  spark: { model: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Spark", color: "cyan" },
  "5.3-spark": { model: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Spark", color: "cyan" },
  // GPT-5.2 family - amber/orange
  "5.2": { model: "gpt-5.2", displayName: "GPT-5.2", color: "amber" },
  "5.2-codex": { model: "gpt-5.2-codex", displayName: "GPT-5.2 Codex", color: "orange" },
} as const;

const AGENT_MENTION_AUTOCOMPLETE_ALIASES = [
  "5.2",
  "5.2-codex",
  "codex",
  "spark",
  "5.4",
  "mini",
] as const;

// ── Helper Functions ──────────────────────────────────────────────────

/**
 * Get all available agent aliases for autocomplete.
 * Returns array sorted by alias name.
 */
export function getAgentMentionAliases(): ResolvedAgentAlias[] {
  return Object.entries(AGENT_MENTION_ALIASES)
    .map(([alias, { model, displayName, color }]) => ({
      alias,
      model,
      displayName,
      color,
    }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

/**
 * Get the preferred aliases shown in autocomplete.
 * Keeps hidden compatibility aliases valid for parsing without duplicating rows in the picker.
 */
export function getAgentMentionAutocompleteAliases(): ResolvedAgentAlias[] {
  return AGENT_MENTION_AUTOCOMPLETE_ALIASES.map((alias) => {
    const definition = AGENT_MENTION_ALIASES[alias];
    if (!definition) {
      throw new Error(`Unknown autocomplete alias: ${alias}`);
    }
    return {
      alias,
      model: definition.model,
      displayName: definition.displayName,
      color: definition.color,
    };
  });
}

/**
 * Resolve an agent alias to its model slug.
 * Case-insensitive lookup.
 * @returns Resolved alias info or null if not found
 */
export function resolveAgentAlias(alias: string): AgentAliasDefinition | null {
  const normalized = alias.toLowerCase();
  return AGENT_MENTION_ALIASES[normalized] ?? null;
}

/**
 * Check if a string is a valid agent alias.
 */
export function isValidAgentAlias(alias: string): boolean {
  return resolveAgentAlias(alias) !== null;
}

/**
 * Get the list of all alias names (for validation/autocomplete).
 */
export function getAgentAliasNames(): string[] {
  return Object.keys(AGENT_MENTION_ALIASES);
}
