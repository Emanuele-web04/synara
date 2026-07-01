/**
 * DevinModelCatalog - Devin model fallback data.
 *
 * PROVENANCE: This is a snapshot of the models advertised by `devin acp`
 * (Devin CLI) as of 2026-06. It is FALLBACK DATA ONLY — the authoritative
 * model list comes from the live ACP session's "model" config option
 * (see listModels in Layers/DevinAdapter.ts). Update this snapshot only when
 * Devin's defaults change; never let UI or tests treat it as runtime truth.
 *
 * @module DevinModelCatalog
 */
import { MODEL_OPTIONS_BY_PROVIDER, MODEL_SLUG_ALIASES_BY_PROVIDER } from "@t3tools/contracts";
import { parseDevinModelSlug, type ParsedDevinSlug } from "./DevinModelSlugParser";

export const DEVIN_FALLBACK_MODELS = MODEL_OPTIONS_BY_PROVIDER.devin.map((option) => ({
  slug: option.slug,
  name: option.name,
}));

export function normalizeDevinModelSlug(model: string): string {
  const trimmed = model.trim();
  return MODEL_SLUG_ALIASES_BY_PROVIDER.devin[trimmed.toLowerCase()] ?? trimmed;
}

export interface DevinModelVariant {
  readonly slug: string;
  readonly name: string;
  readonly effort: string | null;
  readonly fast: boolean;
  readonly thinking: boolean;
  readonly contextWindow: string | null;
}

export interface DevinBaseModel {
  readonly baseSlug: string;
  readonly baseName: string;
  readonly variants: ReadonlyArray<DevinModelVariant>;
  readonly supportedEfforts: ReadonlyArray<string>;
  readonly supportsFastMode: boolean;
  readonly supportsThinking: boolean;
  readonly contextWindowOptions: ReadonlyArray<string>;
  readonly defaultVariant: DevinModelVariant;
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "none", "minimal", "slow"];
const EFFORT_RANK = new Map(EFFORT_ORDER.map((e, i) => [e, i]));

export function buildDevinVariantMatrix(
  models: ReadonlyArray<{ slug: string; name: string }>,
): ReadonlyMap<string, DevinBaseModel> {
  // Pair each model with its parsed result so variants retain the original slug/name.
  type Entry = { slug: string; name: string; parsed: ParsedDevinSlug };
  const groups = new Map<string, Entry[]>();
  for (const model of models) {
    const parsed = parseDevinModelSlug(model.slug, model.name);
    if (!parsed) continue;
    const entry: Entry = { slug: model.slug, name: model.name, parsed };
    const group = groups.get(parsed.baseSlug);
    if (group) {
      group.push(entry);
    } else {
      groups.set(parsed.baseSlug, [entry]);
    }
  }

  const matrix = new Map<string, DevinBaseModel>();
  for (const [baseSlug, entries] of groups) {
    const variants: DevinModelVariant[] = entries.map((e) => ({
      slug: e.slug,
      name: e.name,
      effort: e.parsed.effort,
      fast: e.parsed.fast,
      thinking: e.parsed.thinking,
      contextWindow: e.parsed.contextWindow,
    }));

    const effortSet = new Set<string>();
    const contextSet = new Set<string>();
    let supportsFastMode = false;
    let supportsThinking = false;
    for (const v of variants) {
      if (v.effort !== null) effortSet.add(v.effort);
      if (v.fast) supportsFastMode = true;
      if (v.thinking) supportsThinking = true;
      if (v.contextWindow !== null) contextSet.add(v.contextWindow);
    }
    const supportedEfforts = [...effortSet].sort(
      (a, b) =>
        (EFFORT_RANK.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (EFFORT_RANK.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
    const contextWindowOptions = [...contextSet];

    const bare = variants.find(
      (v) => v.effort === null && !v.fast && !v.thinking && v.contextWindow === null,
    );
    const medium = variants.find((v) => v.effort === "medium");
    const defaultVariant: DevinModelVariant = bare ?? medium ?? variants[0]!;

    matrix.set(baseSlug, {
      baseSlug,
      baseName: entries[0]!.parsed.baseName,
      variants,
      supportedEfforts,
      supportsFastMode,
      supportsThinking,
      contextWindowOptions,
      defaultVariant,
    });
  }
  return matrix;
}

export function resolveDevinModelSlug(
  model: string,
  options:
    | { reasoningEffort?: string; fastMode?: boolean; thinking?: boolean; contextWindow?: string }
    | undefined,
  matrix: ReadonlyMap<string, DevinBaseModel>,
): string | null {
  const base = matrix.get(model);
  if (!base) return model;

  const hasOptions =
    options !== undefined &&
    (options.reasoningEffort !== undefined ||
      options.fastMode !== undefined ||
      options.thinking !== undefined ||
      options.contextWindow !== undefined);
  if (!hasOptions) return base.defaultVariant.slug;

  const targetEffort = options.reasoningEffort ?? base.defaultVariant.effort;
  const targetFast = options.fastMode ?? base.defaultVariant.fast;
  const targetThinking = options.thinking ?? base.defaultVariant.thinking;
  const targetContext = options.contextWindow ?? base.defaultVariant.contextWindow;

  const exact = base.variants.find(
    (v) =>
      v.effort === targetEffort &&
      v.fast === targetFast &&
      v.thinking === targetThinking &&
      v.contextWindow === targetContext,
  );
  if (exact) return exact.slug;

  const effortOnly = base.variants.find(
    (v) => v.effort === targetEffort && !v.fast && !v.thinking && v.contextWindow === null,
  );
  if (effortOnly) return effortOnly.slug;

  return base.defaultVariant.slug;
}
