// Anonymous usage categories shared by the snapshot producer, desktop queue and
// analytics receiver. Only bundled catalog values may cross these boundaries.
import { MODEL_CAPABILITIES_INDEX, ProviderKind } from "@synara/contracts";
import { normalizeModelSlug, stripClaudeContextWindowSuffix } from "./model";

// Also used by analytics SQL read guards; migrations freeze this vocabulary once.
export const USAGE_ANALYTICS_VOCABULARY = {
  provider: ProviderKind.literals,
  models: Object.fromEntries(
    Object.entries(MODEL_CAPABILITIES_INDEX).map(([provider, models]) => [
      provider,
      Object.keys(models),
    ]),
  ) as Readonly<Record<string, readonly string[]>>,
  effort: [
    "default",
    "none",
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultrathink",
    "ultracode",
  ],
  interactionMode: ["default", "plan", "debug"],
  runtimeMode: ["approval-required", "auto", "full-access"],
  origin: ["user", "automation", "agent"],
} as const;
const PROVIDERS = new Set<string>(USAGE_ANALYTICS_VOCABULARY.provider);
const MODELS = new Map(
  Object.entries(USAGE_ANALYTICS_VOCABULARY.models).map(([provider, models]) => [
    provider,
    new Set(models),
  ]),
);
const EFFORTS = new Set<string>(USAGE_ANALYTICS_VOCABULARY.effort);
const INTERACTION_MODES = new Set<string>(USAGE_ANALYTICS_VOCABULARY.interactionMode);
const RUNTIME_MODES = new Set<string>(USAGE_ANALYTICS_VOCABULARY.runtimeMode);
const ORIGINS = new Set<string>(USAGE_ANALYTICS_VOCABULARY.origin);

const category = (value: unknown, allowed: ReadonlySet<string>) =>
  typeof value === "string" && allowed.has(value) ? value : "other";

export const usageProviderCategory = (value: unknown): string => category(value, PROVIDERS);

/** Normalize known aliases, then require a finite bundled model; custom ids stay local. */
function usageModelCategory(provider: string, model: unknown): string {
  if (typeof model !== "string" || !PROVIDERS.has(provider)) return "other";
  const normalized = normalizeModelSlug(model, provider as ProviderKind);
  if (!normalized) return "other";
  const slug = stripClaudeContextWindowSuffix(normalized).toLowerCase();
  return MODELS.get(provider)?.has(slug) ? slug : "other";
}

/** Rebuild every dimension independently so syntactically valid private text is discarded. */
export function usageTurnCategories(row: {
  provider?: unknown;
  model?: unknown;
  effort?: unknown;
  interactionMode?: unknown;
  runtimeMode?: unknown;
  origin?: unknown;
}) {
  const provider = usageProviderCategory(row.provider);
  return {
    provider,
    model: usageModelCategory(provider, row.model),
    effort: category(row.effort, EFFORTS),
    interactionMode: category(row.interactionMode, INTERACTION_MODES),
    runtimeMode: category(row.runtimeMode, RUNTIME_MODES),
    origin: category(row.origin, ORIGINS),
  };
}
