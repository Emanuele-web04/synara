import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import type { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];
export const CLAUDE_API_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeApiEffort = (typeof CLAUDE_API_EFFORT_OPTIONS)[number];
export const CLAUDE_PROMPT_MODE_OPTIONS = ["ultrathink"] as const;
export type ClaudePromptMode = (typeof CLAUDE_PROMPT_MODE_OPTIONS)[number];
export const CLAUDE_CODE_MODE_OPTIONS = ["ultracode"] as const;
export type ClaudeCodeMode = (typeof CLAUDE_CODE_MODE_OPTIONS)[number];
export const CLAUDE_CODE_EFFORT_OPTIONS = [
  ...CLAUDE_API_EFFORT_OPTIONS,
  ...CLAUDE_PROMPT_MODE_OPTIONS,
  ...CLAUDE_CODE_MODE_OPTIONS,
] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];
export const GEMINI_THINKING_LEVEL_OPTIONS = ["LOW", "HIGH"] as const;
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVEL_OPTIONS)[number];
export const GEMINI_THINKING_BUDGET_OPTIONS = [-1, 512, 0] as const;
export type GeminiThinkingBudget = (typeof GEMINI_THINKING_BUDGET_OPTIONS)[number];
export const PI_THINKING_LEVEL_OPTIONS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVEL_OPTIONS)[number];
export const GROK_REASONING_EFFORT_OPTIONS = ["none", "low", "medium", "high"] as const;
export type GrokReasoningEffort = (typeof GROK_REASONING_EFFORT_OPTIONS)[number];
export const DROID_REASONING_EFFORT_OPTIONS = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type DroidReasoningEffort = (typeof DROID_REASONING_EFFORT_OPTIONS)[number];
export type ProviderReasoningEffort =
  | CodexReasoningEffort
  | ClaudeCodeEffort
  | GeminiThinkingLevel
  | `${GeminiThinkingBudget}`
  | PiThinkingLevel
  | GrokReasoningEffort
  | DroidReasoningEffort;

export const ProviderOptionChoice = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  isDefault: Schema.optional(Schema.Literal(true)),
});
export type ProviderOptionChoice = typeof ProviderOptionChoice.Type;

const ProviderOptionDescriptorBase = {
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
} as const;

export const SelectProviderOptionDescriptor = Schema.Struct({
  ...ProviderOptionDescriptorBase,
  type: Schema.Literal("select"),
  options: Schema.Array(ProviderOptionChoice),
  currentValue: Schema.optional(TrimmedNonEmptyString),
  promptInjectedValues: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type SelectProviderOptionDescriptor = typeof SelectProviderOptionDescriptor.Type;

export const BooleanProviderOptionDescriptor = Schema.Struct({
  ...ProviderOptionDescriptorBase,
  type: Schema.Literal("boolean"),
  currentValue: Schema.optional(Schema.Boolean),
});
export type BooleanProviderOptionDescriptor = typeof BooleanProviderOptionDescriptor.Type;

export const ProviderOptionDescriptor = Schema.Union([
  SelectProviderOptionDescriptor,
  BooleanProviderOptionDescriptor,
]);
export type ProviderOptionDescriptor = typeof ProviderOptionDescriptor.Type;

export const ProviderOptionSelection = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: Schema.Union([TrimmedNonEmptyString, Schema.Boolean]),
});
export type ProviderOptionSelection = typeof ProviderOptionSelection.Type;

export const ProviderOptionSelections = Schema.Array(ProviderOptionSelection);
export type ProviderOptionSelections = typeof ProviderOptionSelections.Type;

export const CodexModelOptions = Schema.Struct({
  // Codex runtime discovery can expose early-access effort values outside the built-in enum.
  reasoningEffort: Schema.optional(TrimmedNonEmptyString),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(Schema.Literals(CLAUDE_CODE_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.String),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

export const GeminiModelOptions = Schema.Struct({
  thinkingLevel: Schema.optional(Schema.Literals(GEMINI_THINKING_LEVEL_OPTIONS)),
  thinkingBudget: Schema.optional(Schema.Literals(GEMINI_THINKING_BUDGET_OPTIONS)),
});
export type GeminiModelOptions = typeof GeminiModelOptions.Type;

export const OpenCodeModelOptions = Schema.Struct({
  variant: Schema.optional(TrimmedNonEmptyString),
  agent: Schema.optional(TrimmedNonEmptyString),
});
export type OpenCodeModelOptions = typeof OpenCodeModelOptions.Type;

export const PiModelOptions = Schema.Struct({
  thinkingLevel: Schema.optional(Schema.Literals(PI_THINKING_LEVEL_OPTIONS)),
});
export type PiModelOptions = typeof PiModelOptions.Type;

export const CursorModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(TrimmedNonEmptyString),
  fastMode: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.String),
});
export type CursorModelOptions = typeof CursorModelOptions.Type;

export const GrokModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(GROK_REASONING_EFFORT_OPTIONS)),
});
export type GrokModelOptions = typeof GrokModelOptions.Type;

export const DroidModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(DROID_REASONING_EFFORT_OPTIONS)),
});
export type DroidModelOptions = typeof DroidModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
  cursor: Schema.optional(CursorModelOptions),
  gemini: Schema.optional(GeminiModelOptions),
  grok: Schema.optional(GrokModelOptions),
  droid: Schema.optional(DroidModelOptions),
  kilo: Schema.optional(OpenCodeModelOptions),
  opencode: Schema.optional(OpenCodeModelOptions),
  pi: Schema.optional(PiModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export type ReasoningControlSource = "api-effort" | "provider-setting" | "prompt-prefix";

type EffortOptionBase = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: true;
};

export type EffortOption =
  | (EffortOptionBase & {
      readonly controlSource?: "api-effort";
      readonly apiEffortValue?: never;
    })
  | (EffortOptionBase & {
      readonly controlSource: "provider-setting";
      readonly apiEffortValue: string;
    })
  | (EffortOptionBase & {
      readonly controlSource: "prompt-prefix";
      readonly apiEffortValue?: never;
    });

export type ContextWindowOption = {
  readonly value: string;
  readonly label: string;
  readonly isDefault?: true;
};

export type ModelCapabilities = {
  readonly optionDescriptors?: readonly ProviderOptionDescriptor[];
  readonly reasoningEffortLevels: readonly EffortOption[];
  readonly supportsFastMode: boolean;
  readonly supportsThinkingToggle: boolean;
  readonly promptInjectedEffortLevels: readonly string[];
  readonly contextWindowOptions: readonly ContextWindowOption[];
  readonly variantOptions?: readonly EffortOption[];
  readonly agentOptions?: readonly EffortOption[];
};

const GEMINI_2_5_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "-1", label: "Dynamic", isDefault: true },
    { value: "512", label: "512 Tokens" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  contextWindowOptions: [],
};

const CODEX_GPT_5_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "xhigh", label: "Extra High" },
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  contextWindowOptions: [],
};

const CODEX_GPT_5_5_CAPABILITIES: ModelCapabilities = {
  ...CODEX_GPT_5_CAPABILITIES,
  reasoningEffortLevels: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
  ],
};

const GROK_BUILD_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "none", label: "None" },
    { value: "low", label: "Low", isDefault: true },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  contextWindowOptions: [],
};

function droidCapabilities(reasoningEffortLevels: readonly EffortOption[]): ModelCapabilities {
  return {
    reasoningEffortLevels,
    supportsFastMode: false,
    supportsThinkingToggle: false,
    promptInjectedEffortLevels: [],
    contextWindowOptions: [],
  };
}

const DROID_CLAUDE_XHIGH_CAPABILITIES = droidCapabilities([
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High", isDefault: true },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
]);

const DROID_CLAUDE_MAX_CAPABILITIES = droidCapabilities([
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High", isDefault: true },
  { value: "max", label: "Max" },
]);

const DROID_CLAUDE_BASIC_CAPABILITIES = droidCapabilities([
  { value: "off", label: "Off", isDefault: true },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
]);

const DROID_GPT_MEDIUM_CAPABILITIES = droidCapabilities([
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", isDefault: true },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
]);

const DROID_GPT_HIGH_CAPABILITIES = droidCapabilities([
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High", isDefault: true },
  { value: "xhigh", label: "Extra High" },
]);

const DROID_GPT_5_2_CAPABILITIES = droidCapabilities([
  { value: "off", label: "Off" },
  { value: "low", label: "Low", isDefault: true },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
]);

const DROID_GEMINI_HIGH_CAPABILITIES = droidCapabilities([
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High", isDefault: true },
]);

const DROID_GEMINI_MINIMAL_CAPABILITIES = droidCapabilities([
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High", isDefault: true },
]);

const DROID_CORE_HIGH_CAPABILITIES = droidCapabilities([
  { value: "off", label: "Off" },
  { value: "high", label: "High", isDefault: true },
]);

const DROID_CORE_DEEPSEEK_CAPABILITIES = droidCapabilities([
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "high", label: "High", isDefault: true },
  { value: "max", label: "Max" },
]);

const DROID_CORE_HIGH_ONLY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  contextWindowOptions: [],
};

const DROID_CORE_MINIMAX_M2_5_CAPABILITIES = droidCapabilities([
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High", isDefault: true },
]);

// Shared Claude building blocks. Capability shapes repeat across Claude
// generations, so declare them once and let each model entry override only the
// fields that genuinely differ (mirrors the CODEX_GPT_5_* pattern above).
const CLAUDE_DUAL_CONTEXT_WINDOW: readonly ContextWindowOption[] = [
  { value: "200k", label: "200k", isDefault: true },
  { value: "1m", label: "1M" },
];

function claudeApiEffortOption(
  value: ClaudeApiEffort,
  label: string,
  options: Pick<EffortOption, "isDefault"> = {},
): EffortOption {
  return { value, label, controlSource: "api-effort", ...options };
}

function claudePromptModeOption(value: ClaudePromptMode, label: string): EffortOption {
  return { value, label, controlSource: "prompt-prefix" };
}

function claudeCodeModeOption(
  value: ClaudeCodeMode,
  label: string,
  apiEffortValue: ClaudeApiEffort,
  description: string,
): EffortOption {
  return { value, label, description, apiEffortValue, controlSource: "provider-setting" };
}

// No-fast xhigh ladder: newer Claude Code models with xhigh/max API efforts and
// the ultracode mode setting, but no ultrathink prompt mode or fast mode.
const CLAUDE_NO_FAST_XHIGH_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    claudeApiEffortOption("low", "Low"),
    claudeApiEffortOption("medium", "Medium"),
    claudeApiEffortOption("high", "High", { isDefault: true }),
    claudeApiEffortOption("xhigh", "Extra High"),
    claudeApiEffortOption("max", "Max"),
    claudeCodeModeOption("ultracode", "Ultracode", "xhigh", "xhigh + workflows"),
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  contextWindowOptions: CLAUDE_DUAL_CONTEXT_WINDOW,
};

const CLAUDE_FABLE_CAPABILITIES: ModelCapabilities = CLAUDE_NO_FAST_XHIGH_CAPABILITIES;

// Full reasoning ladder: xhigh + ultracode + ultrathink (Opus 4.7/4.8).
const CLAUDE_FLAGSHIP_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    claudeApiEffortOption("low", "Low"),
    claudeApiEffortOption("medium", "Medium"),
    claudeApiEffortOption("high", "High", { isDefault: true }),
    claudeApiEffortOption("xhigh", "Extra High"),
    claudeApiEffortOption("max", "Max"),
    claudePromptModeOption("ultrathink", "Ultrathink"),
    claudeCodeModeOption("ultracode", "Ultracode", "xhigh", "xhigh + workflows"),
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: ["ultrathink"],
  contextWindowOptions: CLAUDE_DUAL_CONTEXT_WINDOW,
};

// Reasoning ladder before xhigh/ultracode landed (Opus 4.6, Sonnet 4.6).
const CLAUDE_EXTENDED_THINKING_CAPABILITIES: ModelCapabilities = {
  ...CLAUDE_FLAGSHIP_CAPABILITIES,
  reasoningEffortLevels: [
    claudeApiEffortOption("low", "Low"),
    claudeApiEffortOption("medium", "Medium"),
    claudeApiEffortOption("high", "High", { isDefault: true }),
    claudeApiEffortOption("max", "Max"),
    claudePromptModeOption("ultrathink", "Ultrathink"),
  ],
};

// Sonnet 5 adds xhigh for long agentic work, while staying in the Sonnet no-fast-mode lane.
const CLAUDE_SONNET_5_CAPABILITIES: ModelCapabilities = CLAUDE_NO_FAST_XHIGH_CAPABILITIES;

type ModelDefinition = {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
};

/**
 * TODO: This should not be a static array, each provider
 * should return its own model list over the WS API.
 */
export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    {
      slug: "gpt-5.5",
      name: "GPT-5.5",
      capabilities: CODEX_GPT_5_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.2-codex",
      name: "GPT-5.2 Codex",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.2",
      name: "GPT-5.2",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
  ],
  claudeAgent: [
    {
      slug: "claude-fable-5",
      name: "Claude Fable 5",
      capabilities: CLAUDE_FABLE_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      capabilities: CLAUDE_FLAGSHIP_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      capabilities: CLAUDE_FLAGSHIP_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      capabilities: CLAUDE_EXTENDED_THINKING_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      capabilities: {
        reasoningEffortLevels: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High", isDefault: true },
        ],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: CLAUDE_DUAL_CONTEXT_WINDOW,
      },
    },
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      capabilities: CLAUDE_SONNET_5_CAPABILITIES,
    },
    {
      slug: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      capabilities: { ...CLAUDE_EXTENDED_THINKING_CAPABILITIES, supportsFastMode: false },
    },
    {
      slug: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: true,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
  ],
  gemini: [
    {
      slug: "auto-gemini-3",
      name: "Auto Gemini 3",
      capabilities: {
        reasoningEffortLevels: [
          { value: "HIGH", label: "High", isDefault: true },
          { value: "LOW", label: "Low" },
        ],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
    {
      slug: "auto-gemini-2.5",
      name: "Auto Gemini 2.5",
      capabilities: GEMINI_2_5_CAPABILITIES,
    },
    {
      slug: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
      capabilities: {
        reasoningEffortLevels: [
          { value: "HIGH", label: "High", isDefault: true },
          { value: "LOW", label: "Low" },
        ],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
    {
      slug: "gemini-3-flash-preview",
      name: "Gemini 3 Flash Preview",
      capabilities: {
        reasoningEffortLevels: [
          { value: "HIGH", label: "High", isDefault: true },
          { value: "LOW", label: "Low" },
        ],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
    {
      slug: "gemini-3.1-flash-lite-preview",
      name: "Gemini 3.1 Flash Lite Preview",
      capabilities: {
        reasoningEffortLevels: [
          { value: "HIGH", label: "High", isDefault: true },
          { value: "LOW", label: "Low" },
        ],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
    {
      slug: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      capabilities: GEMINI_2_5_CAPABILITIES,
    },
    {
      slug: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      capabilities: GEMINI_2_5_CAPABILITIES,
    },
    {
      slug: "gemini-2.5-flash-lite",
      name: "Gemini 2.5 Flash Lite",
      capabilities: GEMINI_2_5_CAPABILITIES,
    },
  ],
  grok: [
    {
      slug: "grok-build-0.1",
      name: "Grok Build 0.1",
      capabilities: GROK_BUILD_CAPABILITIES,
    },
    {
      slug: "grok-build",
      name: "Grok 4.3",
      capabilities: GROK_BUILD_CAPABILITIES,
    },
  ],
  droid: [
    {
      slug: "claude-fable-5",
      name: "Claude Fable 5",
      capabilities: DROID_CLAUDE_XHIGH_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      capabilities: DROID_CLAUDE_XHIGH_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-8-fast",
      name: "Claude Opus 4.8 Fast",
      capabilities: DROID_CLAUDE_XHIGH_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      capabilities: DROID_CLAUDE_MAX_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-7-fast",
      name: "Claude Opus 4.7 Fast",
      capabilities: DROID_CLAUDE_MAX_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      capabilities: DROID_CLAUDE_MAX_CAPABILITIES,
    },
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      capabilities: DROID_CLAUDE_XHIGH_CAPABILITIES,
    },
    {
      slug: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      capabilities: DROID_CLAUDE_MAX_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-5-20251101",
      name: "Claude Opus 4.5",
      capabilities: DROID_CLAUDE_BASIC_CAPABILITIES,
    },
    {
      slug: "claude-sonnet-4-5-20250929",
      name: "Claude Sonnet 4.5",
      capabilities: DROID_CLAUDE_BASIC_CAPABILITIES,
    },
    {
      slug: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5",
      capabilities: DROID_CLAUDE_BASIC_CAPABILITIES,
    },
    {
      slug: "gpt-5.5",
      name: "GPT-5.5",
      capabilities: DROID_GPT_MEDIUM_CAPABILITIES,
    },
    {
      slug: "gpt-5.5-fast",
      name: "GPT-5.5 Fast",
      capabilities: DROID_GPT_MEDIUM_CAPABILITIES,
    },
    {
      slug: "gpt-5.5-pro",
      name: "GPT-5.5 Pro",
      capabilities: DROID_GPT_MEDIUM_CAPABILITIES,
    },
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      capabilities: DROID_GPT_MEDIUM_CAPABILITIES,
    },
    {
      slug: "gpt-5.4-fast",
      name: "GPT-5.4 Fast",
      capabilities: DROID_GPT_MEDIUM_CAPABILITIES,
    },
    {
      slug: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      capabilities: DROID_GPT_HIGH_CAPABILITIES,
    },
    {
      slug: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      capabilities: DROID_GPT_MEDIUM_CAPABILITIES,
    },
    {
      slug: "gpt-5.3-codex-fast",
      name: "GPT-5.3 Codex Fast",
      capabilities: DROID_GPT_MEDIUM_CAPABILITIES,
    },
    {
      slug: "gpt-5.2",
      name: "GPT-5.2",
      capabilities: DROID_GPT_5_2_CAPABILITIES,
    },
    {
      slug: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro",
      capabilities: DROID_GEMINI_HIGH_CAPABILITIES,
    },
    {
      slug: "gemini-3.5-flash",
      name: "Gemini 3.5 Flash",
      capabilities: DROID_GEMINI_MINIMAL_CAPABILITIES,
    },
    {
      slug: "gemini-3-flash-preview",
      name: "Gemini 3 Flash",
      capabilities: DROID_GEMINI_MINIMAL_CAPABILITIES,
    },
    {
      slug: "glm-5.2",
      name: "GLM-5.2",
      capabilities: DROID_CORE_HIGH_CAPABILITIES,
    },
    {
      slug: "glm-5.1",
      name: "GLM-5.1",
      capabilities: DROID_CORE_HIGH_CAPABILITIES,
    },
    {
      slug: "nemotron-3-ultra",
      name: "Nemotron 3 Ultra",
      capabilities: DROID_CORE_HIGH_CAPABILITIES,
    },
    {
      slug: "kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      capabilities: DROID_CORE_HIGH_CAPABILITIES,
    },
    {
      slug: "kimi-k2.6",
      name: "Kimi K2.6",
      capabilities: DROID_CORE_HIGH_CAPABILITIES,
    },
    {
      slug: "kimi-k2.5",
      name: "Kimi K2.5",
      capabilities: DROID_CORE_HIGH_CAPABILITIES,
    },
    {
      slug: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      capabilities: DROID_CORE_DEEPSEEK_CAPABILITIES,
    },
    {
      slug: "minimax-m3",
      name: "MiniMax M3",
      capabilities: DROID_CORE_HIGH_ONLY_CAPABILITIES,
    },
    {
      slug: "minimax-m2.7",
      name: "MiniMax M2.7",
      capabilities: DROID_CORE_HIGH_ONLY_CAPABILITIES,
    },
    {
      slug: "minimax-m2.5",
      name: "MiniMax M2.5",
      capabilities: DROID_CORE_MINIMAX_M2_5_CAPABILITIES,
    },
  ],
  opencode: [
    {
      slug: "openai/gpt-5",
      name: "OpenAI GPT-5",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
  ],
  kilo: [
    {
      slug: "kilo/kilo-auto/free",
      name: "Kilo Auto Free",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
  ],
  pi: [],
  cursor: [
    {
      slug: "auto",
      name: "Auto",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
    {
      slug: "composer-2",
      name: "Composer 2",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
    {
      slug: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      capabilities: {
        reasoningEffortLevels: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High", isDefault: true },
          { value: "max", label: "Max" },
        ],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
    {
      slug: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
    {
      slug: "gemini-3-pro",
      name: "Gemini 3 Pro",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
  ],
} as const satisfies Record<ProviderKind, readonly ModelDefinition[]>;
export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

type BuiltInModelSlug = (typeof MODEL_OPTIONS_BY_PROVIDER)[ProviderKind][number]["slug"];
export type ModelSlug = BuiltInModelSlug | (string & {});

export type ProviderWithDefaultModel = Exclude<ProviderKind, "pi">;

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderWithDefaultModel, ModelSlug> = {
  codex: "gpt-5.5",
  claudeAgent: "claude-sonnet-5",
  cursor: "auto",
  gemini: "auto-gemini-3",
  grok: "grok-build",
  droid: "claude-opus-4-8",
  kilo: "kilo/kilo-auto/free",
  opencode: "openai/gpt-5",
};

// Backward compatibility for existing Codex-only call sites.
export const MODEL_OPTIONS = MODEL_OPTIONS_BY_PROVIDER.codex;
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;
export const DEFAULT_GIT_TEXT_GENERATION_MODEL = "gpt-5.4-mini" as const;

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, ModelSlug>> = {
  codex: {
    "5.5": "gpt-5.5",
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  claudeAgent: {
    fable: "claude-fable-5",
    "fable-5": "claude-fable-5",
    opus: "claude-opus-4-8",
    "opus-4.8": "claude-opus-4-8",
    "claude-opus-4.8": "claude-opus-4-8",
    "claude-opus-4-8-20260528": "claude-opus-4-8",
    "opus-4.7": "claude-opus-4-7",
    "claude-opus-4.7": "claude-opus-4-7",
    "claude-opus-4-7-20260416": "claude-opus-4-7",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    "opus-4.5": "claude-opus-4-5",
    "claude-opus-4.5": "claude-opus-4-5",
    "claude-opus-4-5-20250120": "claude-opus-4-5",
    sonnet: "claude-sonnet-5",
    "sonnet-5": "claude-sonnet-5",
    "claude-sonnet-5": "claude-sonnet-5",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
  cursor: {
    auto: "auto",
    composer: "composer-2",
    "composer-2": "composer-2",
    "composer-1.5": "composer-1.5",
    "composer-1": "composer-1.5",
    "opus-4.6": "claude-opus-4-6",
    "opus-4.6-thinking": "claude-opus-4-6",
    "gpt-5.3": "gpt-5.3-codex",
    "codex-5.3": "gpt-5.3-codex",
    "gemini-3": "gemini-3-pro",
  },
  gemini: {
    auto: "auto-gemini-3",
    "auto-gemini-3": "auto-gemini-3",
    "auto-gemini-2.5": "auto-gemini-2.5",
    "gemini-3-pro-preview": "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
    "gemini-3-flash-preview": "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite-preview",
    "gemini-2.5-pro": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
  },
  droid: {
    droid: "claude-opus-4-8",
    factory: "claude-opus-4-8",
    opus: "claude-opus-4-8",
    "opus-4.8": "claude-opus-4-8",
    "opus-fast": "claude-opus-4-8-fast",
    "opus-4.8-fast": "claude-opus-4-8-fast",
    "opus-4.7": "claude-opus-4-7",
    "opus-4.7-fast": "claude-opus-4-7-fast",
    "opus-4.6": "claude-opus-4-6",
    sonnet: "claude-sonnet-5",
    "sonnet-5": "claude-sonnet-5",
    "sonnet-4.6": "claude-sonnet-4-6",
    "sonnet-4.5": "claude-sonnet-4-5-20250929",
    fable: "claude-fable-5",
    haiku: "claude-haiku-4-5-20251001",
    "5.5": "gpt-5.5",
    "5.5-fast": "gpt-5.5-fast",
    "5.5-pro": "gpt-5.5-pro",
    "5.4": "gpt-5.4",
    "5.4-fast": "gpt-5.4-fast",
    "5.4-mini": "gpt-5.4-mini",
    "5.3": "gpt-5.3-codex",
    "5.3-fast": "gpt-5.3-codex-fast",
    "gpt-5.3": "gpt-5.3-codex",
    "gemini-3-pro": "gemini-3.1-pro-preview",
    "gemini-3.1-pro": "gemini-3.1-pro-preview",
    "gemini-3.5-flash": "gemini-3.5-flash",
    "gemini-3-flash": "gemini-3-flash-preview",
    glm: "glm-5.2",
    "glm-5.2": "glm-5.2",
    "glm-5.1": "glm-5.1",
    nemotron: "nemotron-3-ultra",
    kimi: "kimi-k2.7-code",
    "kimi-code": "kimi-k2.7-code",
    deepseek: "deepseek-v4-pro",
    minimax: "minimax-m3",
  },
  grok: {
    grok: "grok-build-0.1",
    build: "grok-build-0.1",
    "grok-build-0.1": "grok-build-0.1",
    "grok-build": "grok-build",
    "4.3": "grok-build",
    "grok-4": "grok-build",
    "grok-4.3": "grok-build",
    "grok-latest": "grok-build",
    "grok-code-fast": "grok-build-0.1",
    "grok-code-fast-1": "grok-build-0.1",
    "grok-code-fast-1-0825": "grok-build-0.1",
    "code-fast": "grok-build-0.1",
  },
  kilo: {},
  opencode: {},
  pi: {},
};

// ── Agent mention aliases ─────────────────────────────────────────────
// Re-exported from agentMentions.ts for backward compatibility
export {
  AGENT_MENTION_ALIASES,
  getAgentMentionAutocompleteAliases,
  getAgentMentionAliases,
  resolveAgentAlias,
  isValidAgentAlias,
  getAgentAliasNames,
  type AgentAliasDefinition,
  type ResolvedAgentAlias,
} from "./agentMentions";

// ── Model capabilities index ──────────────────────────────────────────

export const MODEL_CAPABILITIES_INDEX = Object.fromEntries(
  Object.entries(MODEL_OPTIONS_BY_PROVIDER).map(([provider, models]) => [
    provider,
    Object.fromEntries(models.map((m) => [m.slug, m.capabilities])),
  ]),
) as unknown as Record<ProviderKind, Record<string, ModelCapabilities>>;

// ── Provider display names ────────────────────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  gemini: "Gemini",
  grok: "Grok",
  droid: "Droid",
  kilo: "Kilo",
  opencode: "OpenCode",
  pi: "Pi",
};
