import { Effect, Schema } from "effect";
import type { ChatAttachment } from "@t3tools/contracts";

import { TextGenerationError } from "./Errors.ts";

export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return {
      ...document.schema,
      $defs: document.definitions,
    };
  }
  return document.schema;
}

export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

export const REVIEW_CONTEXT_BUDGET_CHARS = 50_000;

export function limitContext(
  value: string,
  maxChars: number = REVIEW_CONTEXT_BUDGET_CHARS,
): string {
  return limitSection(value, maxChars);
}

export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) {
    return trimmed;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, index + 1);
      }
    }
  }

  return trimmed.slice(start);
}

// Describes how to recover a single-field result from non-JSON output. `maxWords` rejects
// sentence-length prose so it never masquerades as a short field (e.g. a title or branch),
// letting the caller fall back to its own message-derived default instead.
export interface RawTextFallback {
  readonly key: string;
  readonly maxWords?: number;
}

function stripCodeFences(raw: string): string {
  const fenced = raw.match(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/);
  return (fenced?.[1] ?? raw).trim();
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Prefer the requested field, otherwise the first usable string value, so a wrong-key
// JSON object (e.g. {"name":"Foo"}) yields "Foo" instead of the literal braces.
function pickFallbackString(parsed: Record<string, unknown>, key: string): string | null {
  const preferred = parsed[key];
  if (typeof preferred === "string" && preferred.trim().length > 0) {
    return preferred.trim();
  }
  for (const value of Object.values(parsed)) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function coerceRawTextToFallback(raw: string, fallback: RawTextFallback): string | null {
  const cleaned = stripCodeFences(raw);
  if (cleaned.length === 0) {
    return null;
  }
  const parsed = tryParseJsonObject(cleaned);
  const candidate = parsed ? pickFallbackString(parsed, fallback.key) : cleaned;
  if (candidate === null || candidate.length === 0) {
    return null;
  }
  if (fallback.maxWords !== undefined) {
    const wordCount = candidate.split(/\s+/u).filter((word) => word.length > 0).length;
    if (wordCount > fallback.maxWords) {
      return null;
    }
  }
  return candidate;
}

// Free-text providers (Cursor/OpenCode/Kilo ACP) are only *asked* to emit JSON, unlike Codex
// which enforces `--output-schema`. For single-field prompts (title/branch/summary) they often
// reply with the bare value or surrounding prose, so coerce that raw text into the expected
// single-string field instead of failing the whole generation.
export function decodeStructuredTextGenerationOutput<S extends Schema.Top>(input: {
  readonly schema: S;
  readonly raw: string;
  readonly operation: string;
  readonly providerLabel: string;
  readonly rawTextFallback?: RawTextFallback;
}): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> {
  const decode = Schema.decodeEffect(Schema.fromJsonString(input.schema));
  const toError = (cause: unknown) =>
    new TextGenerationError({
      operation: input.operation,
      detail: `${input.providerLabel} returned invalid structured output.`,
      cause,
    });
  return decode(extractJsonObject(input.raw)).pipe(
    Effect.catchTag("SchemaError", (error) => {
      const fallback = input.rawTextFallback;
      const coerced = fallback ? coerceRawTextToFallback(input.raw, fallback) : null;
      if (!fallback || coerced === null) {
        return Effect.fail(toError(error));
      }
      return decode(JSON.stringify({ [fallback.key]: coerced })).pipe(
        Effect.catchTag("SchemaError", (innerError) => Effect.fail(toError(innerError))),
      );
    }),
  );
}

export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

export function sanitizeDiffSummary(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  return [
    "## Summary",
    "- Update the current diff.",
    "",
    "## Files Changed",
    "- Not available.",
  ].join("\n");
}

function attachmentMetadataLines(attachments: ReadonlyArray<ChatAttachment> | undefined): string[] {
  return (attachments ?? [])
    .filter((attachment) => attachment.type === "image")
    .map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
    );
}

export function buildCommitMessagePrompt(input: {
  readonly branch: string | null;
  readonly stagedSummary: string;
  readonly stagedPatch: string;
  readonly includeBranch: boolean;
}) {
  const prompt = [
    "You write concise git commit messages.",
    input.includeBranch
      ? "Return a JSON object with keys: subject, body, branch."
      : "Return a JSON object with keys: subject, body.",
    "Respond with only the JSON object, no prose and no code fences.",
    "Rules:",
    "- subject must be imperative, <= 72 chars, and no trailing period",
    "- body can be empty string or short bullet points",
    ...(input.includeBranch
      ? ["- branch must be a short semantic git branch fragment for this change"]
      : []),
    "- capture the primary user-visible or developer-visible change",
    "",
    `Branch: ${input.branch ?? "(detached)"}`,
    "",
    "Staged files:",
    limitSection(input.stagedSummary, 6_000),
    "",
    "Staged patch:",
    limitSection(input.stagedPatch, 40_000),
  ].join("\n");

  const outputSchemaJson = input.includeBranch
    ? Schema.Struct({
        subject: Schema.String,
        body: Schema.String,
        branch: Schema.String,
      })
    : Schema.Struct({
        subject: Schema.String,
        body: Schema.String,
      });

  return { prompt, outputSchemaJson };
}

export function buildPrContentPrompt(input: {
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly commitSummary: string;
  readonly diffSummary: string;
  readonly diffPatch: string;
}) {
  return {
    prompt: [
      "You write GitHub pull request content.",
      "Return a JSON object with keys: title, body.",
      "Respond with only the JSON object, no prose and no code fences.",
      "Rules:",
      "- title should be concise and specific",
      "- body must be markdown and include headings '## Summary' and '## Testing'",
      "- under Summary, provide short bullet points",
      "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
      "",
      `Base branch: ${input.baseBranch}`,
      `Head branch: ${input.headBranch}`,
      "",
      "Commits:",
      limitSection(input.commitSummary, 12_000),
      "",
      "Diff stat:",
      limitSection(input.diffSummary, 12_000),
      "",
      "Diff patch:",
      limitSection(input.diffPatch, 40_000),
    ].join("\n"),
    outputSchemaJson: Schema.Struct({
      title: Schema.String,
      body: Schema.String,
    }),
  };
}

export function buildDiffSummaryPrompt(input: { readonly patch: string }) {
  return {
    prompt: [
      "You write GitHub-style engineering summaries for git diffs.",
      "Return a JSON object with key: summary.",
      "Respond with only the JSON object, no prose and no code fences.",
      "Rules:",
      "- summary must be markdown",
      "- include headings '## Summary' and '## Files Changed'",
      "- under each heading, use concise bullet points",
      "- describe only changes directly supported by the diff",
      "- mention risks or follow-ups only when clearly implied by the patch",
      "- do not invent tests, tickets, or product context",
      "",
      "Diff patch:",
      limitSection(input.patch, 50_000),
    ].join("\n"),
    outputSchemaJson: Schema.Struct({
      summary: Schema.String,
    }),
    rawTextFallback: { key: "summary" } satisfies RawTextFallback,
  };
}

export function buildReviewFindingsPrompt(input: {
  readonly patch: string;
  readonly prTitle?: string;
  readonly prBody?: string;
}) {
  const sections = [
    "You are a senior code reviewer.",
    "Given a unified diff, return a JSON object with keys: summary, findings.",
    "Respond with only the JSON object, no prose and no code fences.",
    "Rules:",
    "- summary is a short plain-text overview of the change and its risks",
    "- findings is an array; each finding cites a line PRESENT in the diff",
    "- side must be RIGHT for an added/new-side line or LEFT for a removed/old-side line",
    "- severity must be one of blocker, major, minor, nit",
    "- title is a short phrase; message explains the issue and a suggested fix",
    "- do NOT invent files or lines that are not in the diff",
    "- use the PR title and description only as context; anchor findings to the diff",
    "- prefer few high-signal findings over many low-value ones",
    "- return an empty findings array if nothing is actionable",
  ];
  if (input.prTitle && input.prTitle.trim().length > 0) {
    sections.push("", "PR title:", limitSection(input.prTitle.trim(), 2_000));
  }
  if (input.prBody && input.prBody.trim().length > 0) {
    sections.push("", "PR description:", limitContext(input.prBody.trim(), 8_000));
  }
  sections.push("", "Diff patch:", limitContext(input.patch, 50_000));
  return { prompt: sections.join("\n") };
}

export function buildBranchNamePrompt(input: {
  readonly message: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}) {
  const attachmentLines = attachmentMetadataLines(input.attachments);
  const promptSections = [
    "You generate concise git branch names.",
    "Return a JSON object with key: branch.",
    "Respond with only the JSON object, no prose and no code fences.",
    "Rules:",
    "- Branch should describe the requested work from the user message.",
    "- Keep it short and specific (2-6 words).",
    "- Use plain words only, no issue prefixes and no punctuation-heavy text.",
    "- If images are attached, use them as primary context for visual/UI issues.",
    "",
    "User message:",
    limitSection(input.message, 8_000),
  ];
  if (attachmentLines.length > 0) {
    promptSections.push(
      "",
      "Attachment metadata:",
      limitSection(attachmentLines.join("\n"), 4_000),
    );
  }

  return {
    prompt: promptSections.join("\n"),
    outputSchemaJson: Schema.Struct({
      branch: Schema.String,
    }),
    rawTextFallback: { key: "branch", maxWords: 8 } satisfies RawTextFallback,
  };
}

export function buildThreadTitlePrompt(input: {
  readonly message: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}) {
  const attachmentLines = attachmentMetadataLines(input.attachments);
  const promptSections = [
    "You generate concise chat thread titles.",
    "Return a JSON object with key: title.",
    "Respond with only the JSON object, no prose and no code fences.",
    "Rules:",
    "- Summarize the user's request in 2-4 words.",
    "- Never exceed 4 words.",
    "- Use a short noun or verb phrase, not a full sentence.",
    "- Avoid quotes, markdown, emoji, and trailing punctuation.",
    "- If images are attached, use them as primary context for the title.",
    "",
    "User message:",
    limitSection(input.message, 8_000),
  ];
  if (attachmentLines.length > 0) {
    promptSections.push(
      "",
      "Attachment metadata:",
      limitSection(attachmentLines.join("\n"), 4_000),
    );
  }

  return {
    prompt: promptSections.join("\n"),
    outputSchemaJson: Schema.Struct({
      title: Schema.String,
    }),
    rawTextFallback: { key: "title", maxWords: 8 } satisfies RawTextFallback,
  };
}
