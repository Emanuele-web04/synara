import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type {
  AutomationMode,
  ChatAttachment,
  ModelSelection,
  ProviderStartOptions,
  ServerGenerateAutomationIntentResult,
  SourceControlWritingStyle,
} from "@synara/contracts";

import type { TextGenerationError } from "../Errors.ts";

/** Server-owned writing preferences; repository examples are untrusted style references. */
export interface SourceControlWritingPreferences {
  readonly style: SourceControlWritingStyle;
  readonly customInstructions: string;
  readonly recentCommitSubjects: readonly string[];
  readonly recentPrTitles: readonly string[];
}

export interface CommitMessageGenerationInput {
  writingPreferences?: SourceControlWritingPreferences;
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  codexHomePath?: string;
  includeBranch?: boolean;
  model?: string;
  modelSelection?: ModelSelection;
  providerOptions?: ProviderStartOptions;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** only present when `includeBranch` was set */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  writingPreferences?: SourceControlWritingPreferences;
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  /** fill a repository PR template instead of the default body shape */
  prTemplate?: string | undefined;
  codexHomePath?: string;
  model?: string;
  modelSelection?: ModelSelection;
  providerOptions?: ProviderStartOptions;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface DiffSummaryGenerationInput {
  cwd: string;
  patch: string;
  codexHomePath?: string;
  model?: string;
  modelSelection?: ModelSelection;
  providerOptions?: ProviderStartOptions;
}

export interface DiffSummaryGenerationResult {
  summary: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  model?: string;
  modelSelection?: ModelSelection;
  providerOptions?: ProviderStartOptions;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** regenerate from durable conversation context instead of a single first-turn prompt */
  context?: "conversation";
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  model?: string;
  modelSelection?: ModelSelection;
  providerOptions?: ProviderStartOptions;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface ThreadRecapGenerationInput {
  cwd: string;
  previousRecap?: string | undefined;
  newMaterial: string;
  currentState?: string | undefined;
  codexHomePath?: string;
  model?: string;
  modelSelection?: ModelSelection;
  providerOptions?: ProviderStartOptions;
}

export interface ThreadRecapGenerationResult {
  recap: string;
}

export interface AutomationIntentGenerationInput {
  cwd: string;
  message: string;
  defaultMode?: AutomationMode;
  nowIso: string;
  codexHomePath?: string;
  model?: string;
  modelSelection?: ModelSelection;
  providerOptions?: ProviderStartOptions;
}

export type AutomationIntentGenerationResult = ServerGenerateAutomationIntentResult;

export interface AutomationCompletionEvaluationInput {
  cwd: string;
  automationName: string;
  automationPrompt: string;
  stopWhen: string;
  runUserMessage: string;
  runAssistantText: string;
  threadContext?: string | undefined;
  codexHomePath?: string;
  model?: string;
  modelSelection?: ModelSelection;
  providerOptions?: ProviderStartOptions;
}

export interface AutomationCompletionEvaluationResult {
  stopMatched: boolean;
  confidence: number;
  reason: string;
}

export interface ProjectDigestGenerationInput {
  cwd: string;
  previousSummary?: string | undefined;
  activity: string;
  coverage: string;
  pinnedFocus: string;
  codexHomePath?: string;
  model?: string;
  modelSelection?: ModelSelection;
  providerOptions?: ProviderStartOptions;
}

export interface ProjectDigestGenerationResult {
  summary: string;
  focusItems: ReadonlyArray<{
    title: string;
    kind: "task" | "message" | "artifact" | "blocker";
    source: string;
  }>;
}

export type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateDiffSummary"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateThreadRecap"
  | "generateProjectDigest"
  | "generateAutomationIntent"
  | "evaluateAutomationCompletion";

export interface TextGenerationShape {
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  readonly generateDiffSummary: (
    input: DiffSummaryGenerationInput,
  ) => Effect.Effect<DiffSummaryGenerationResult, TextGenerationError>;

  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  readonly generateThreadRecap: (
    input: ThreadRecapGenerationInput,
  ) => Effect.Effect<ThreadRecapGenerationResult, TextGenerationError>;
  readonly generateProjectDigest: (
    input: ProjectDigestGenerationInput,
  ) => Effect.Effect<ProjectDigestGenerationResult, TextGenerationError>;

  readonly generateAutomationIntent: (
    input: AutomationIntentGenerationInput,
  ) => Effect.Effect<AutomationIntentGenerationResult, TextGenerationError>;

  readonly evaluateAutomationCompletion: (
    input: AutomationCompletionEvaluationInput,
  ) => Effect.Effect<AutomationCompletionEvaluationResult, TextGenerationError>;
}

export class CodexTextGeneration extends ServiceMap.Service<
  CodexTextGeneration,
  TextGenerationShape
>()("synara/git/Services/TextGeneration/CodexTextGeneration") {}

/**
 * ClaudeTextGeneration - Provider-specific Claude implementation for git text generation.
 */
export class ClaudeTextGeneration extends ServiceMap.Service<
  ClaudeTextGeneration,
  TextGenerationShape
>()("synara/git/Services/TextGeneration/ClaudeTextGeneration") {}

/**
 * OpenCodeTextGeneration - Provider-specific OpenCode implementation for git text generation.
 */
export class OpenCodeTextGeneration extends ServiceMap.Service<
  OpenCodeTextGeneration,
  TextGenerationShape
>()("synara/git/Services/TextGeneration/OpenCodeTextGeneration") {}

export class CursorTextGeneration extends ServiceMap.Service<
  CursorTextGeneration,
  TextGenerationShape
>()("synara/git/Services/TextGeneration/CursorTextGeneration") {}

export class DroidTextGeneration extends ServiceMap.Service<
  DroidTextGeneration,
  TextGenerationShape
>()("synara/git/Services/TextGeneration/DroidTextGeneration") {}

export class TextGeneration extends ServiceMap.Service<TextGeneration, TextGenerationShape>()(
  "synara/git/Services/TextGeneration",
) {}
