/**
 * CursorAcpSupport.parsing - pure string/parameter parsing for Cursor models.
 *
 * Purpose: parse and normalize Cursor model ids, parameter suffixes, reasoning
 * effort values, and display names. No Effect, no IO, no config-option access.
 * Layer: pure functions over strings and CursorModelOptions.
 * Exports: text + model-id parsers, parameter (de)serializers, reasoning/context
 *   label helpers, and option-inference helpers used by the helpers/runtime modules.
 *
 * @module CursorAcpSupport.parsing
 */
import { type CursorModelOptions, type ProviderModelDescriptor } from "@t3tools/contracts";
import { formatModelDisplayName } from "@t3tools/shared/model";

import type { CursorAcpSelectOption } from "./CursorAcpSupport.types.ts";

export function resolveCursorAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "auto") return "auto";
  const parameterStart = trimmed.indexOf("[");
  return parameterStart === -1 ? trimmed : trimmed.slice(0, parameterStart).trim() || "auto";
}

export function normalizedText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

export function stripCursorParameterizedSuffix(value: string): string {
  const trimmed = value.trim();
  const suffixStart = trimmed.indexOf("[");
  return suffixStart >= 0 ? trimmed.slice(0, suffixStart).trim() : trimmed;
}

export function parseCursorModelParameters(value: string): ReadonlyMap<string, string> {
  const match = value.match(/\[([^\]]*)\]$/u);
  if (!match?.[1]) {
    return new Map();
  }
  const params = new Map<string, string>();
  for (const part of match[1].split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = part.slice(0, separatorIndex).trim();
    const paramValue = part.slice(separatorIndex + 1).trim();
    if (key && paramValue) {
      params.set(key, paramValue);
    }
  }
  return params;
}

export function cursorModelParametersToObject(value: string): Record<string, string> {
  return Object.fromEntries(parseCursorModelParameters(value).entries());
}

export function buildCursorParameterizedModelSlug(
  baseModel: string,
  params: Record<string, string>,
): string {
  const entries = Object.entries(params).filter(([, value]) => value.trim().length > 0);
  if (entries.length === 0) {
    return baseModel;
  }
  return `${baseModel}[${entries.map(([key, value]) => `${key}=${value}`).join(",")}]`;
}

export function humanizeCursorModelName(value: string): string {
  const base = stripCursorParameterizedSuffix(value);
  if (base.length === 0) {
    return value;
  }
  const sharedDisplayName = formatModelDisplayName(base);
  if (sharedDisplayName) {
    return sharedDisplayName;
  }
  return base
    .split(/[-_/]+/u)
    .filter((part) => part.length > 0)
    .map((part) => {
      const lower = part.toLowerCase();
      if (/^gpt$/u.test(lower)) return "GPT";
      if (/^ai$/u.test(lower)) return "AI";
      if (/^codex$/u.test(lower)) return "Codex";
      if (/^claude$/u.test(lower)) return "Claude";
      if (/^opus$/u.test(lower)) return "Opus";
      if (/^sonnet$/u.test(lower)) return "Sonnet";
      if (/^haiku$/u.test(lower)) return "Haiku";
      if (/^gemini$/u.test(lower)) return "Gemini";
      if (/^grok$/u.test(lower)) return "Grok";
      if (/^kimi$/u.test(lower)) return "Kimi";
      if (/^llama$/u.test(lower)) return "Llama";
      if (/^qwen$/u.test(lower)) return "Qwen";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function normalizeCursorAcpModelName(choice: CursorAcpSelectOption): string {
  const rawName = choice.name.trim();
  const rawBase = stripCursorParameterizedSuffix(choice.value);
  if (
    rawName.length > 0 &&
    rawName.toLowerCase() !== choice.value.trim().toLowerCase() &&
    rawName.toLowerCase() !== rawBase.toLowerCase()
  ) {
    return rawName;
  }
  return humanizeCursorModelName(choice.value);
}

export function inferCursorUpstreamProvider(choice: CursorAcpSelectOption): {
  readonly upstreamProviderId: string;
  readonly upstreamProviderName: string;
} {
  const groupId = choice.groupId?.trim();
  const groupName = choice.groupName?.trim();
  if (groupId || groupName) {
    return {
      upstreamProviderId: (groupId || groupName || "cursor").toLowerCase().replace(/\s+/gu, "-"),
      upstreamProviderName: groupName || groupId || "Cursor",
    };
  }

  const token = stripCursorParameterizedSuffix(`${choice.value} ${choice.name}`)
    .trim()
    .toLowerCase();
  if (token.includes("claude")) {
    return { upstreamProviderId: "anthropic", upstreamProviderName: "Anthropic" };
  }
  if (token.includes("gemini")) {
    return { upstreamProviderId: "google", upstreamProviderName: "Google" };
  }
  if (token.includes("grok")) {
    return { upstreamProviderId: "xai", upstreamProviderName: "xAI" };
  }
  if (token.includes("kimi")) {
    return { upstreamProviderId: "moonshot", upstreamProviderName: "Moonshot AI" };
  }
  if (token.includes("deepseek")) {
    return { upstreamProviderId: "deepseek", upstreamProviderName: "DeepSeek" };
  }
  if (token.includes("qwen")) {
    return { upstreamProviderId: "alibaba", upstreamProviderName: "Alibaba" };
  }
  if (token.includes("llama")) {
    return { upstreamProviderId: "meta", upstreamProviderName: "Meta" };
  }
  if (token.includes("mistral")) {
    return { upstreamProviderId: "mistral", upstreamProviderName: "Mistral" };
  }
  if (token.includes("nemotron")) {
    return { upstreamProviderId: "nvidia", upstreamProviderName: "NVIDIA" };
  }
  if (
    token.includes("gpt") ||
    token.includes("codex") ||
    token.includes("o1") ||
    token.includes("o3") ||
    token.includes("o4")
  ) {
    return { upstreamProviderId: "openai", upstreamProviderName: "OpenAI" };
  }
  return { upstreamProviderId: "cursor", upstreamProviderName: "Cursor" };
}

export function normalizeCursorCliBaseModelId(model: string): string {
  const trimmed = model.trim();
  const withoutVariantSuffixes = trimmed
    .replace(/-fast$/u, "")
    .replace(/-(?:extra-high|none|low|medium|high|xhigh)$/u, "")
    .replace(/-thinking$/u, "")
    .replace(/-fast$/u, "")
    .replace(/-(?:extra-high|none|low|medium|high|xhigh)$/u, "")
    .replace(/^claude-(\d+(?:\.\d+)?)-([a-z]+)-max$/u, "claude-$1-$2")
    .replace(/-preview$/u, "");

  const claudeReordered = withoutVariantSuffixes.match(/^claude-(\d+(?:\.\d+)?)-([a-z]+)$/u);
  if (claudeReordered) {
    const version = claudeReordered[1];
    const family = claudeReordered[2];
    if (!version || !family) {
      return withoutVariantSuffixes;
    }
    return `claude-${family}-${version.replace(".", "-")}`;
  }
  return withoutVariantSuffixes;
}

export function parseCursorCliReasoningEffort(model: string): string | undefined {
  const tokens = model.trim().toLowerCase().split("-");
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === "xhigh") {
      return "xhigh";
    }
    if (token === "high" && tokens[index - 1] === "extra") {
      return "xhigh";
    }
    if (
      token === "max" ||
      token === "none" ||
      token === "low" ||
      token === "medium" ||
      token === "high"
    ) {
      return token;
    }
  }
  return undefined;
}

export function isCursorCliOneMillionContextModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("gpt-5.5-")) {
    return true;
  }
  if (/^gpt-5\.4-(?:low|medium|high|xhigh|extra-high)$/u.test(normalized)) {
    return true;
  }
  if (/^claude-4\.6-(?:opus|sonnet)(?:-|$)/u.test(normalized)) {
    return true;
  }
  if (/^claude-(?:fable-5|opus-4-(?:7|8))-/u.test(normalized)) {
    return true;
  }
  return false;
}

export function cursorModelOptionsFromCliModelId(
  model: string | null | undefined,
): CursorModelOptions {
  const trimmed = model?.trim();
  if (!trimmed || trimmed.includes("[")) {
    return {};
  }

  const lower = trimmed.toLowerCase();
  const reasoningEffort = parseCursorCliReasoningEffort(lower);
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(lower.endsWith("-fast") ? { fastMode: true } : {}),
    ...(lower.includes("-thinking") ? { thinking: true } : {}),
    ...(isCursorCliOneMillionContextModel(lower) ? { contextWindow: "1m" } : {}),
  };
}

export function cursorAcpParameterKeyForModel(
  baseModel: string,
  options: CursorModelOptions,
): string {
  if (options.reasoningEffort && baseModel.includes("claude")) {
    return "effort";
  }
  return "reasoning";
}

export function normalizeCursorReasoningValue(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

export function cursorReasoningParameterValue(value: string): string {
  return value === "xhigh" ? "extra-high" : value;
}

export function cursorReasoningLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

export function cursorContextLabel(
  value: string,
  contextWindowOptions: NonNullable<ProviderModelDescriptor["contextWindowOptions"]>,
): string {
  return (
    contextWindowOptions.find((option) => option.value === value)?.label ?? value.toUpperCase()
  );
}

export function cursorModelOptionsFromModelParameters(
  model: string | null | undefined,
): CursorModelOptions | undefined {
  if (!model) {
    return undefined;
  }
  const params = parseCursorModelParameters(model);
  const reasoningEffort = normalizeCursorReasoningValue(
    params.get("reasoning") ?? params.get("effort"),
  );
  const contextWindow = params.get("context")?.trim();
  const fastModeParam = params.get("fast")?.trim().toLowerCase();
  const thinkingParam = params.get("thinking")?.trim().toLowerCase();
  const fastMode = fastModeParam === "true" ? true : fastModeParam === "false" ? false : undefined;
  const thinking = thinkingParam === "true" ? true : thinkingParam === "false" ? false : undefined;
  const options: CursorModelOptions = {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

export function mergeCursorModelOptions(
  base: CursorModelOptions | undefined,
  override: CursorModelOptions | null | undefined,
): CursorModelOptions | undefined {
  const merged: CursorModelOptions = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function cursorModelParametersEqualExceptFast(left: string, right: string): boolean {
  const leftParams = cursorModelParametersToObject(left);
  const rightParams = cursorModelParametersToObject(right);
  delete leftParams.fast;
  delete rightParams.fast;
  return JSON.stringify(leftParams) === JSON.stringify(rightParams);
}

export function cursorModelChoiceSupportsRequestedParameters(
  choice: string,
  requested: string,
): boolean {
  if (stripCursorParameterizedSuffix(choice) !== stripCursorParameterizedSuffix(requested)) {
    return false;
  }

  const choiceParams = parseCursorModelParameters(choice);
  const requestedParams = parseCursorModelParameters(requested);
  for (const [key, requestedValue] of requestedParams) {
    const choiceValue = choiceParams.get(key);
    if (choiceValue === requestedValue) {
      continue;
    }
    if ((key === "fast" || key === "thinking") && requestedValue === "false") {
      continue;
    }
    return false;
  }
  return true;
}
