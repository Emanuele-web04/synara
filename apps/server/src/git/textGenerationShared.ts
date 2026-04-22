import { Schema } from "effect";
import type { ChatAttachment } from "@t3tools/contracts";

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
  };
}

export function buildBranchNamePrompt(input: {
  readonly message: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}) {
  const attachmentLines = attachmentMetadataLines(input.attachments);
  const promptSections = [
    "You generate concise git branch names.",
    "Return a JSON object with key: branch.",
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
  };
}
