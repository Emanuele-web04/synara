/**
 * TextGeneration - Effect service contract for AI-generated Git content.
 *
 * Generates commit messages and pull request titles/bodies from repository
 * context prepared by Git services.
 *
 * @module TextGeneration
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ChatAttachment, ModelSelection, ProviderStartOptions } from "@t3tools/contracts";

import type { TextGenerationError } from "../Errors.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  codexHomePath?: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  codexHomePath?: string;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
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
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export interface DiffSummaryGenerationResult {
  summary: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateDiffSummary(input: DiffSummaryGenerationInput): Promise<DiffSummaryGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
}

/**
 * TextGenerationShape - Service API for AI-generated Git and thread text.
 */
export interface TextGenerationShape {
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  /**
   * Generate pull request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a GitHub-style markdown summary for an existing diff patch.
   */
  readonly generateDiffSummary: (
    input: DiffSummaryGenerationInput,
  ) => Effect.Effect<DiffSummaryGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /**
   * Generate a concise chat-thread title from the first user message.
   */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
}

/**
 * CodexTextGeneration - Provider-specific Codex implementation for git text generation.
 */
export class CodexTextGeneration extends ServiceMap.Service<
  CodexTextGeneration,
  TextGenerationShape
>()("t3/git/Services/TextGeneration/CodexTextGeneration") {}

/**
 * OpenCodeTextGeneration - Provider-specific OpenCode implementation for git text generation.
 */
export class OpenCodeTextGeneration extends ServiceMap.Service<
  OpenCodeTextGeneration,
  TextGenerationShape
>()("t3/git/Services/TextGeneration/OpenCodeTextGeneration") {}

/**
 * CursorTextGeneration - Provider-specific Cursor implementation for git text generation.
 */
export class CursorTextGeneration extends ServiceMap.Service<
  CursorTextGeneration,
  TextGenerationShape
>()("t3/git/Services/TextGeneration/CursorTextGeneration") {}

/**
 * TextGeneration - Service tag for commit and PR text generation.
 */
export class TextGeneration extends ServiceMap.Service<TextGeneration, TextGenerationShape>()(
  "t3/git/Services/TextGeneration",
) {}
