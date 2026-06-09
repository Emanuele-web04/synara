/**
 * GeminiAdapter.models - Model/config-alias and request-shape helpers for Gemini.
 *
 * Purpose: build Gemini CLI thinking-config aliases, resolve ACP request timeouts,
 * and map runtime modes to Gemini mode ids. Pure functions only.
 *
 * @module GeminiAdapter.models
 */
import {
  getModelCapabilities,
  getGeminiThinkingConfigKind,
  getGeminiThinkingModelAlias,
  hasEffortLevel,
} from "@t3tools/shared/model";

import type { ProviderSession } from "@t3tools/contracts";

import {
  GEMINI_2_5_THINKING_BUDGETS,
  GEMINI_3_THINKING_LEVELS,
  GEMINI_ACP_PROMPT_TIMEOUT_MS,
  GEMINI_ACP_REQUEST_TIMEOUT_MS,
} from "./GeminiAdapter.config.ts";

export function buildGeminiThinkingModelConfigAliases(
  modelIds: ReadonlyArray<string>,
): Record<string, Record<string, unknown>> {
  const aliases: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();

  for (const modelId of modelIds) {
    const model = modelId.trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    const caps = getModelCapabilities("gemini", model);

    switch (getGeminiThinkingConfigKind(model)) {
      case "level": {
        for (const thinkingLevel of GEMINI_3_THINKING_LEVELS) {
          if (!hasEffortLevel(caps, thinkingLevel)) {
            continue;
          }
          const alias = getGeminiThinkingModelAlias(model, { thinkingLevel });
          if (!alias) {
            continue;
          }
          aliases[alias] = {
            extends: "chat-base-3",
            modelConfig: {
              model,
              generateContentConfig: {
                thinkingConfig: {
                  thinkingLevel,
                },
              },
            },
          };
        }
        break;
      }
      case "budget": {
        for (const thinkingBudget of GEMINI_2_5_THINKING_BUDGETS) {
          if (!hasEffortLevel(caps, String(thinkingBudget))) {
            continue;
          }
          const alias = getGeminiThinkingModelAlias(model, { thinkingBudget });
          if (!alias) {
            continue;
          }
          aliases[alias] = {
            extends: "chat-base-2.5",
            modelConfig: {
              model,
              generateContentConfig: {
                thinkingConfig: {
                  thinkingBudget,
                },
              },
            },
          };
        }
        break;
      }
      default:
        break;
    }
  }

  return aliases;
}

export function geminiRequestTimeoutMs(method: string): number {
  return method === "session/prompt" ? GEMINI_ACP_PROMPT_TIMEOUT_MS : GEMINI_ACP_REQUEST_TIMEOUT_MS;
}

export function runtimeModeToGeminiModeId(runtimeMode: ProviderSession["runtimeMode"]): string {
  switch (runtimeMode) {
    case "approval-required":
      return "default";
    case "full-access":
    default:
      return "yolo";
  }
}
