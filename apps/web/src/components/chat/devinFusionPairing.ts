// FILE: devinFusionPairing.ts
// Purpose: Parses Devin "pairing" families (Fusion) into lead/effort/fast/sidekick
//   parts so the composer can offer a real pairing picker. Pairing variants encode
//   two models in one concrete UID — `<family>-<lead>-<effort>[-fast]-sidekick-<sk>`
//   — which the generic effort/fast trait controls cannot express. Pickers commit
//   the exact UID through the `modelVariant` option, which the adapter passes
//   verbatim as the Devin process `--model`.
// Layer: Chat composer state helpers
// Depends on: contracts variant descriptors and shared model-name helpers.

import {
  type DevinModelOptions,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ProviderModelVariantDescriptor,
} from "@synara/contracts";
import { humanizeModelSlug, trimOrNull } from "@synara/shared/model";

import { type ProviderOptions } from "../../providerModelOptions";

const PAIRING_SEPARATOR = "-sidekick-";

// Every lead effort token Devin has shipped in a pairing UID. Ordered for display.
const PAIRING_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const PAIRING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export interface DevinPairingParts {
  /** Lead base id without family/effort/fast suffixes, e.g. "claude-fable-5-1". */
  readonly lead: string;
  /** Lead effort token, e.g. "high". */
  readonly effort: string;
  /** Fast lead variant, e.g. the `-fast` in `fusion-gpt-6-sol-high-fast-…`. */
  readonly fast: boolean;
  /** Sidekick model id as reported by the CLI, e.g. "swe-2-medium". */
  readonly sidekick: string;
}

export interface DevinPairingVariant {
  readonly uid: string;
  /** Provider label without the "Fusion (…)" wrapper, e.g. "Claude Fable 5.1 High + SWE-2 Medium". */
  readonly label: string;
  readonly parts: DevinPairingParts;
}

export interface DevinPairingModel {
  readonly slug: string;
  readonly variants: ReadonlyArray<DevinPairingVariant>;
  readonly leads: ReadonlyArray<{ value: string; label: string }>;
  /** All sidekicks offered by the family; per-lead filtering uses `sidekicksFor`. */
  readonly sidekicks: ReadonlyArray<{ value: string; label: string }>;
}

export interface DevinPairingSelection {
  readonly parts: DevinPairingParts;
  /** False while no explicit variant is pinned — the CLI default pairing runs. */
  readonly explicit: boolean;
}

// Strip the "Fusion (…)" wrapper the CLI puts around pairing labels.
function unwrapPairingLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim();
  if (!trimmed) return undefined;
  const open = trimmed.indexOf("(");
  const close = trimmed.lastIndexOf(")");
  if (open >= 0 && close > open) {
    return trimmed.slice(open + 1, close).trim();
  }
  return trimmed;
}

// `<lead>-<effort>[-fast]` → lead base + effort + fast. The effort token is the
// last segment before an optional `-fast`, so lead ids containing effort-shaped
// words elsewhere are unaffected.
function parseLeadPart(leadPart: string): DevinPairingParts | null {
  const match = leadPart.match(/-([a-z]+?)(-fast)?$/u);
  if (!match?.[1]) return null;
  const effort = match[1];
  if (!(PAIRING_EFFORT_ORDER as ReadonlyArray<string>).includes(effort)) return null;
  const lead = leadPart.slice(0, leadPart.length - match[0].length);
  if (!lead) return null;
  return { lead, effort, fast: match[2] !== undefined, sidekick: "" };
}

function parsePairingVariant(
  familySlug: string,
  variant: ProviderModelVariantDescriptor,
): DevinPairingVariant | null {
  const uid = variant.model.trim();
  const prefix = `${familySlug}-`;
  if (!uid.startsWith(prefix)) return null;
  const rest = uid.slice(prefix.length);
  const separatorIndex = rest.indexOf(PAIRING_SEPARATOR);
  if (separatorIndex <= 0) return null;
  const leadPart = rest.slice(0, separatorIndex);
  const sidekick = rest.slice(separatorIndex + PAIRING_SEPARATOR.length).trim();
  if (!sidekick) return null;
  const parsed = parseLeadPart(leadPart);
  if (!parsed) return null;
  return {
    uid,
    label:
      unwrapPairingLabel(variant.label) ??
      `${humanizeModelSlug(parsed.lead)} ${PAIRING_EFFORT_LABELS[parsed.effort] ?? parsed.effort}${
        parsed.fast ? " Fast" : ""
      } + ${humanizeModelSlug(sidekick)}`,
    parts: { ...parsed, sidekick },
  };
}

// Provider label suffixes after " + " carry the sidekick's display name with
// better fidelity than re-humanizing its id ("SWE-2 Medium" vs "SWE 2 Medium").
function sidekickLabel(variant: DevinPairingVariant): string {
  const plusIndex = variant.label.lastIndexOf(" + ");
  return plusIndex >= 0 ? variant.label.slice(plusIndex + 3).trim() : variant.label;
}

function orderEfforts(efforts: Iterable<string>): string[] {
  const present = new Set(efforts);
  return PAIRING_EFFORT_ORDER.filter((effort) => present.has(effort));
}

// A runtime model is a pairing family when its concrete variants follow the
// `<family>-…-sidekick-…` shape. Structural detection survives family renames.
export function getDevinPairingModel(
  provider: ProviderKind,
  runtimeModel: ProviderModelDescriptor | null | undefined,
): DevinPairingModel | null {
  if (provider !== "devin") return null;
  const slug = runtimeModel?.slug?.trim();
  const rawVariants = runtimeModel?.modelVariants;
  if (!slug || !rawVariants?.length) return null;
  const variants = rawVariants
    .map((variant) => parsePairingVariant(slug, variant))
    .filter((variant): variant is DevinPairingVariant => variant !== null);
  if (variants.length === 0) return null;

  const leads = new Map<string, string>();
  const sidekicks = new Map<string, string>();
  for (const variant of variants) {
    if (!leads.has(variant.parts.lead)) {
      leads.set(variant.parts.lead, humanizeModelSlug(variant.parts.lead));
    }
    if (!sidekicks.has(variant.parts.sidekick)) {
      sidekicks.set(variant.parts.sidekick, sidekickLabel(variant));
    }
  }
  return {
    slug,
    variants,
    leads: [...leads].map(([value, label]) => ({ value, label })),
    sidekicks: [...sidekicks].map(([value, label]) => ({ value, label })),
  };
}

export function devinPairingLeadEfforts(
  pairing: DevinPairingModel,
  lead: string,
): ReadonlyArray<{ value: string; label: string }> {
  return orderEfforts(
    pairing.variants
      .filter((variant) => variant.parts.lead === lead)
      .map((variant) => variant.parts.effort),
  ).map((value) => ({ value, label: PAIRING_EFFORT_LABELS[value] ?? value }));
}

export function devinPairingLeadHasFast(pairing: DevinPairingModel, lead: string): boolean {
  return pairing.variants.some((variant) => variant.parts.lead === lead && variant.parts.fast);
}

export function devinPairingSidekicksForLead(
  pairing: DevinPairingModel,
  lead: string,
): ReadonlyArray<{ value: string; label: string }> {
  const forLead = new Set(
    pairing.variants
      .filter((variant) => variant.parts.lead === lead)
      .map((variant) => variant.parts.sidekick),
  );
  const filtered = pairing.sidekicks.filter((option) => forLead.has(option.value));
  return filtered.length > 0 ? filtered : pairing.sidekicks;
}

// Partial parts input that tolerates explicit `undefined` so relaxation can
// clear axes under exactOptionalPropertyTypes.
type DevinPairingPartsInput = {
  readonly lead?: string | undefined;
  readonly effort?: string | undefined;
  readonly fast?: boolean | undefined;
  readonly sidekick?: string | undefined;
};

// Best concrete UID for the requested parts. Each axis keeps the user's intent
// when a variant matches; otherwise the missing coverage falls back in order so
// a just-switched lead still lands on the closest available pairing.
export function resolveDevinPairingUid(
  pairing: DevinPairingModel,
  desired: DevinPairingPartsInput,
): string | undefined {
  const candidates: Array<DevinPairingPartsInput> = [
    desired,
    { ...desired, sidekick: undefined },
    { ...desired, sidekick: undefined, fast: undefined },
    { ...desired, sidekick: undefined, fast: undefined, effort: undefined },
    { lead: desired.lead },
    {},
  ];
  for (const candidate of candidates) {
    const match = pairing.variants.find(
      (variant) =>
        (candidate.lead === undefined || variant.parts.lead === candidate.lead) &&
        (candidate.effort === undefined || variant.parts.effort === candidate.effort) &&
        (candidate.fast === undefined || variant.parts.fast === candidate.fast) &&
        (candidate.sidekick === undefined || variant.parts.sidekick === candidate.sidekick),
    );
    if (match) return match.uid;
  }
  return undefined;
}

// Current pairing the draft runs: the pinned `modelVariant` when it still exists
// in the family, otherwise the family's first variant as the compose baseline.
export function currentDevinPairing(
  pairing: DevinPairingModel,
  modelOptions: ProviderOptions | null | undefined,
): DevinPairingSelection {
  const uid = trimOrNull((modelOptions as DevinModelOptions | null | undefined)?.modelVariant);
  const pinned = uid ? pairing.variants.find((variant) => variant.uid === uid) : undefined;
  const fallback = pairing.variants[0];
  const parts = pinned?.parts ?? fallback?.parts;
  return parts
    ? { parts, explicit: pinned !== undefined }
    : { parts: { lead: "", effort: "", fast: false, sidekick: "" }, explicit: false };
}

// One patch that pins the exact pairing and clears every generic trait — a stale
// effort/fast/context selection would otherwise win over the explicit variant in
// `resolveDevinModelVariant`.
export function buildDevinPairingPatch(uid: string): Record<string, unknown> {
  return {
    modelVariant: uid,
    reasoningEffort: undefined,
    fastMode: undefined,
    thinking: undefined,
    contextWindow: undefined,
  };
}

// Compact trigger/status text for the pinned pairing ("Claude Fable 5.1 High +
// SWE-2 Medium"), or null while the CLI default pairing runs.
export function devinPairingStatusLabel(
  pairing: DevinPairingModel | null,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (!pairing) return null;
  const uid = trimOrNull((modelOptions as DevinModelOptions | null | undefined)?.modelVariant);
  const pinned = uid ? pairing.variants.find((variant) => variant.uid === uid) : undefined;
  return pinned?.label ?? null;
}
