// FILE: devinFusionPairing.ts
// Purpose: Parses Devin "pairing" families (Fusion) into lead/effort/speed/sidekick
//   parts so the composer can offer a real pairing picker. Pairing variants encode
//   two models in one concrete UID — `<family>-<lead>[-<effort>][-<speed>]-sidekick-<sk>`
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

export type DevinPairingSpeed = "standard" | "fast" | "ultrafast";

const PAIRING_SPEED_ORDER: ReadonlyArray<DevinPairingSpeed> = ["standard", "fast", "ultrafast"];

const PAIRING_SPEED_SUFFIXES: ReadonlyArray<{
  readonly suffix: string;
  readonly speed: Exclude<DevinPairingSpeed, "standard">;
}> = [
  { suffix: "-ultrafast", speed: "ultrafast" },
  { suffix: "-lightning", speed: "ultrafast" },
  { suffix: "-priority", speed: "fast" },
  { suffix: "-fast", speed: "fast" },
];

// Canonical display order for known lead effort tokens; unknown future tokens
// discovered from the CLI are preserved after these in alphabetical order.
const PAIRING_EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "adaptive",
  "thinking",
] as const;

const KNOWN_PAIRING_EFFORTS: ReadonlySet<string> = new Set(PAIRING_EFFORT_ORDER);

const PAIRING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  "": "Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
  adaptive: "Adaptive",
  thinking: "Thinking",
};

const PAIRING_SPEED_LABELS: Readonly<Record<DevinPairingSpeed, string>> = {
  standard: "Standard",
  fast: "Fast",
  ultrafast: "Ultrafast",
};

export interface DevinPairingParts {
  /** Lead base id without family/effort/speed suffixes, e.g. "claude-fable-5-1". */
  readonly lead: string;
  /** Lead effort token, e.g. "high", or "" for leads without an effort axis. */
  readonly effort: string;
  /** Lead speed tier: "standard", "fast" (-fast/-priority), or "ultrafast" (-lightning/-ultrafast). */
  readonly speed: DevinPairingSpeed;
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

function humanizeToken(token: string): string {
  return PAIRING_EFFORT_LABELS[token] ?? humanizeModelSlug(token);
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

function stripFamilyPrefix(uid: string, familySlug: string): string | null {
  const directPrefix = `${familySlug}-`;
  if (uid.startsWith(directPrefix)) {
    return uid.slice(directPrefix.length);
  }
  const hyphenatedPrefix = `${familySlug.replaceAll(".", "-")}-`;
  if (hyphenatedPrefix !== directPrefix && uid.startsWith(hyphenatedPrefix)) {
    return uid.slice(hyphenatedPrefix.length);
  }
  return null;
}

function stripTrailingSpeed(leadPart: string): {
  readonly core: string;
  readonly speed: DevinPairingSpeed;
} {
  for (const entry of PAIRING_SPEED_SUFFIXES) {
    if (leadPart.endsWith(entry.suffix) && leadPart.length > entry.suffix.length) {
      return {
        core: leadPart.slice(0, leadPart.length - entry.suffix.length),
        speed: entry.speed,
      };
    }
  }
  return { core: leadPart, speed: "standard" };
}

interface RawPairingEntry {
  readonly uid: string;
  readonly rawLabel: string | undefined;
  readonly leadCore: string;
  readonly speed: DevinPairingSpeed;
  readonly sidekick: string;
}

function extractRawPairingEntry(
  familySlug: string,
  variant: ProviderModelVariantDescriptor,
): RawPairingEntry | null {
  const uid = variant.model.trim();
  const rest = stripFamilyPrefix(uid, familySlug);
  if (!rest) return null;
  const separatorIndex = rest.indexOf(PAIRING_SEPARATOR);
  if (separatorIndex <= 0) return null;
  const leadPart = rest.slice(0, separatorIndex).trim();
  const sidekick = rest.slice(separatorIndex + PAIRING_SEPARATOR.length).trim();
  if (!leadPart || !sidekick) return null;
  const { core, speed } = stripTrailingSpeed(leadPart);
  if (!core) return null;
  return {
    uid,
    rawLabel: unwrapPairingLabel(variant.label),
    leadCore: core,
    speed,
    sidekick,
  };
}

function splitKnownEffort(leadCore: string): { lead: string; effort: string } | null {
  const dashIndex = leadCore.lastIndexOf("-");
  if (dashIndex <= 0) return null;
  const candidateEffort = leadCore.slice(dashIndex + 1);
  if (!KNOWN_PAIRING_EFFORTS.has(candidateEffort)) return null;
  return { lead: leadCore.slice(0, dashIndex), effort: candidateEffort };
}

// Extract the lead's display name from the CLI's pairing label ("GPT-6.2 Sol High
// Thinking Fast + SWE-2 Medium" → "GPT-6.2 Sol") so decimals and brand casing stay
// faithful even for models shipped after this build.
function leadLabelFromProviderLabel(
  rawLabel: string | undefined,
  parts: DevinPairingParts,
): string | null {
  if (!rawLabel) return null;
  const plusIndex = rawLabel.lastIndexOf(" + ");
  if (plusIndex <= 0) return null;
  let text = rawLabel.slice(0, plusIndex).trim();
  if (parts.speed === "ultrafast") {
    text = text.replace(/\s+(?:Ultrafast|Lightning)$/iu, "").trim();
  } else if (parts.speed === "fast") {
    text = text.replace(/\s+(?:Fast|Priority)$/iu, "").trim();
  }
  if (parts.effort && parts.effort !== "thinking") {
    text = text.replace(/\s+Thinking$/iu, "").trim();
  }
  if (parts.effort) {
    const effortLabels = Array.from(
      new Set([
        PAIRING_EFFORT_LABELS[parts.effort],
        parts.effort === "none" ? "No Thinking" : undefined,
        parts.effort === "xhigh" ? "XHigh" : undefined,
        humanizeModelSlug(parts.effort),
        parts.effort,
      ]),
    ).filter((value): value is string => Boolean(value));
    for (const candidate of effortLabels) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const stripped = text.replace(new RegExp(`\\s+${escaped}$`, "iu"), "").trim();
      if (stripped !== text && stripped.length > 0) {
        text = stripped;
        break;
      }
    }
  }
  return text.length > 0 ? text : null;
}

// Provider label suffixes after " + " carry the sidekick's display name with
// better fidelity than re-humanizing its id ("SWE-2 Medium" vs "SWE 2 Medium").
function sidekickLabel(variant: DevinPairingVariant): string {
  const plusIndex = variant.label.lastIndexOf(" + ");
  return plusIndex >= 0 ? variant.label.slice(plusIndex + 3).trim() : variant.label;
}

function orderEfforts(efforts: Iterable<string>): string[] {
  const present = new Set(efforts);
  const ordered: string[] = [];
  if (present.has("")) {
    ordered.push("");
    present.delete("");
  }
  for (const effort of PAIRING_EFFORT_ORDER) {
    if (present.has(effort)) {
      ordered.push(effort);
      present.delete(effort);
    }
  }
  // Any newly introduced effort token from a future CLI release stays selectable.
  const unknown = [...present].toSorted((left, right) => left.localeCompare(right));
  return [...ordered, ...unknown];
}

function fallbackVariantLabel(parts: DevinPairingParts): string {
  const leadParts = [humanizeModelSlug(parts.lead)];
  if (parts.effort) {
    leadParts.push(humanizeToken(parts.effort));
  }
  if (parts.speed !== "standard") {
    leadParts.push(PAIRING_SPEED_LABELS[parts.speed]);
  }
  return `${leadParts.join(" ")} + ${humanizeModelSlug(parts.sidekick)}`;
}

// A runtime model is a pairing family when its concrete variants follow the
// `<family>-…-sidekick-…` shape. Structural detection survives family renames,
// new effort tiers, effortless leads, and new speed tiers without manual updates.
export function getDevinPairingModel(
  provider: ProviderKind,
  runtimeModel: ProviderModelDescriptor | null | undefined,
): DevinPairingModel | null {
  if (provider !== "devin") return null;
  const slug = runtimeModel?.slug?.trim();
  const rawVariants = runtimeModel?.modelVariants;
  if (!slug || !rawVariants?.length) return null;

  const rawEntries = rawVariants
    .map((variant) => extractRawPairingEntry(slug, variant))
    .filter((entry): entry is RawPairingEntry => entry !== null);
  if (rawEntries.length === 0) return null;

  // Pass 1: recognize leads from variants ending in a known effort token.
  const pass1 = rawEntries.map((entry) => ({
    entry,
    known: splitKnownEffort(entry.leadCore),
  }));
  const knownLeads = Array.from(
    new Set(pass1.flatMap((item) => (item.known ? [item.known.lead] : []))),
  ).toSorted((left, right) => right.length - left.length);

  // Pass 2: match unknown future effort tokens on known leads (longest prefix
  // first), and keep standalone effortless leads instead of dropping them.
  const variants: DevinPairingVariant[] = [];
  const leads = new Map<string, string>();
  const sidekicks = new Map<string, string>();

  for (const { entry, known } of pass1) {
    let lead: string;
    let effort: string;
    if (known) {
      lead = known.lead;
      effort = known.effort;
    } else {
      const matchedLead = knownLeads.find((candidate) =>
        entry.leadCore.startsWith(`${candidate}-`),
      );
      if (matchedLead) {
        lead = matchedLead;
        effort = entry.leadCore.slice(matchedLead.length + 1);
      } else {
        lead = entry.leadCore;
        effort = "";
      }
    }

    const parts: DevinPairingParts = {
      lead,
      effort,
      speed: entry.speed,
      sidekick: entry.sidekick,
    };
    const variant: DevinPairingVariant = {
      uid: entry.uid,
      label: entry.rawLabel ?? fallbackVariantLabel(parts),
      parts,
    };
    variants.push(variant);

    if (!leads.has(lead)) {
      leads.set(lead, leadLabelFromProviderLabel(entry.rawLabel, parts) ?? humanizeModelSlug(lead));
    }
    if (!sidekicks.has(parts.sidekick)) {
      sidekicks.set(parts.sidekick, sidekickLabel(variant));
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
  const efforts = orderEfforts(
    pairing.variants
      .filter((variant) => variant.parts.lead === lead)
      .map((variant) => variant.parts.effort),
  );
  // Effortless leads (only "") expose no effort row.
  if (efforts.length === 1 && efforts[0] === "") {
    return [];
  }
  return efforts.map((value) => ({ value, label: humanizeToken(value) }));
}

export function devinPairingLeadSpeeds(
  pairing: DevinPairingModel,
  lead: string,
): ReadonlyArray<DevinPairingSpeed> {
  const present = new Set(
    pairing.variants
      .filter((variant) => variant.parts.lead === lead)
      .map((variant) => variant.parts.speed),
  );
  return PAIRING_SPEED_ORDER.filter((speed) => present.has(speed));
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
  readonly speed?: DevinPairingSpeed | undefined;
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
    { ...desired, speed: undefined },
    { ...desired, sidekick: undefined, speed: undefined },
    { ...desired, effort: undefined, speed: undefined },
    { lead: desired.lead },
    {},
  ];
  for (const candidate of candidates) {
    const match = pairing.variants.find(
      (variant) =>
        (candidate.lead === undefined || variant.parts.lead === candidate.lead) &&
        (candidate.effort === undefined || variant.parts.effort === candidate.effort) &&
        (candidate.speed === undefined || variant.parts.speed === candidate.speed) &&
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
    : { parts: { lead: "", effort: "", speed: "standard", sidekick: "" }, explicit: false };
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
