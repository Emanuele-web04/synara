// FILE: feedback.ts
// Purpose: Owns explicit feedback categories, text sanitization, and delivery.
// Layer: Web feature logic
// Depends on: The public trysynara feedback endpoint.

import type { FeedbackCategory, FeedbackSubmission } from "@synara/contracts";
export type { FeedbackCategory, FeedbackSubmission } from "@synara/contracts";

export const FEEDBACK_CATEGORIES = [
  { value: "bug", label: "Bug" },
  { value: "session", label: "Session" },
  { value: "ui", label: "UI" },
  { value: "performance", label: "Performance" },
  { value: "idea", label: "Idea" },
  { value: "other", label: "Other" },
] as const;

const DEFAULT_FEEDBACK_ENDPOINT = "https://www.trysynara.com/api/feedback";
const FEEDBACK_REQUEST_TIMEOUT_MS = 20_000;

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /gho_[A-Za-z0-9]{20,}/gu,
  /ghu_[A-Za-z0-9]{20,}/gu,
  /ghs_[A-Za-z0-9]{20,}/gu,
  /ghr_[A-Za-z0-9]{20,}/gu,
  /(?<![A-Za-z0-9])sk-proj-[A-Za-z0-9_-]{20,}/gu,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/gu,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/gu,
  /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/gu,
  /(?<![A-Za-z0-9])A(?:KIA|SIA|BIA|CCA)[0-9A-Z]{16}/gu,
  /xox[a-z]-[A-Za-z0-9-]{10,}/gu,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{15,}/gu,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}/gu,
  /(?<![A-Za-z0-9])ya29\.[A-Za-z0-9_-]{20,}/gu,
  /AIza[A-Za-z0-9_-]{35}/gu,
  /\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+={0,2}(?![A-Za-z0-9_=-])/gu,
  /(?<![A-Za-z0-9])bearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}(?![A-Za-z0-9_=-])/giu,
  /-----BEGIN\s+(?:RSA\s+|OPENSSH\s+|EC\s+|DSA\s+|PGP\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|OPENSSH\s+|EC\s+|DSA\s+|PGP\s+)?PRIVATE\s+KEY-----/gu,
  // Credentials embedded in a URL: keep the scheme and host, drop user:pass.
  /(?<=:\/\/)[^/\s:@]+:[^@\s/]+(?=@)/gu,
  // Generic key=value secrets: .env lines and pasted config. The credential word
  // must be a whole key segment: standalone (`password=`), underscore-delimited
  // inside a longer name (`AWS_SECRET_ACCESS_KEY=`, `MY_API_TOKEN=`), plural
  // (`secrets=`, `client_secrets=`), or numeric-suffixed (`TOKEN1=`,
  // `API_KEY2=`). Words that merely start with a credential stem
  // (`passwordless=`, `tokenizer=`, `myPassword=`) are not credentials and
  // must survive unredacted. Quoted JSON keys and values with spaces or
  // escaped quotes are consumed together so no credential suffix remains.
  /(?<![A-Za-z0-9_])["']?(?:[A-Za-z0-9]+_)*(?:password|passwd|secret|api[_-]?key|apikey|token)s?[0-9]*(?:_[A-Za-z0-9]+)*["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'`;,)}&]+)/giu,
] as const;

// Usernames may contain dots and other punctuation (john.doe), so the segment
// after the home prefix stops only at path separators and whitespace. The
// lookbehind also accepts a colon for PATH-style and error-style prefixes
// (PATH=/Users/kartik/bin, Error:/Users/kartik/proj) and a slash so file URLs
// get the same redaction (file:///Users/alice/x). `/root` is the home
// directory itself, not a parent of usernames, so it has no user segment:
// `/root/proj` maps to `~/proj`, never `~/` after eating a directory.
const HOME_PATH_PATTERN =
  /(?<=^|[\s'"`=(:/])(\/Users\/[^/\s]+|\/home\/[^/\s]+|\/root|C:\\Users\\[^/\\\s]+|C:\/Users\/[^/\s]+)(?=[\\/]|[\s.,;:!?()"'`]|$)/giu;

/** Masks high-confidence secrets with `[REDACTED]` and returns the count. */
export function redactObviousSecrets(text: string): { text: string; redactedCount: number } {
  let redactedCount = 0;
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match) => {
      redactedCount += 1;
      return "[REDACTED]";
    });
  }
  return { text: redacted, redactedCount };
}

/** Replaces macOS, Linux, `/root`, and Windows home directory prefixes with `~`. */
export function normalizeHomePaths(text: string): string {
  return text.replace(HOME_PATH_PATTERN, "~");
}

/** Sanitizes user-supplied feedback text before it leaves the app. */
export function sanitizeUntrustedText(text: string): string {
  return normalizeHomePaths(redactObviousSecrets(text).text);
}

export function buildFeedbackSubmission(input: {
  category: FeedbackCategory | null;
  details: string;
}): FeedbackSubmission {
  return {
    category: input.category,
    details: sanitizeUntrustedText(input.details.trim()),
  };
}

function feedbackEndpoint(): string {
  return import.meta.env.VITE_FEEDBACK_ENDPOINT?.trim() || DEFAULT_FEEDBACK_ENDPOINT;
}

export async function submitFeedback(
  submission: FeedbackSubmission,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FEEDBACK_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(feedbackEndpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synara-feedback": "1",
      },
      body: JSON.stringify({ category: submission.category, details: submission.details }),
      signal: controller.signal,
    });
    if (response.ok) return;

    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof payload?.error === "string" ? payload.error.trim() : "";
    throw new Error(message || `Feedback could not be sent (${response.status}).`);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Feedback delivery timed out. Please try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
