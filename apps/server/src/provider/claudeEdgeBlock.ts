import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";

import { isProviderEdgeBlockedText, PROVIDER_EDGE_BLOCKED_ERROR_CODE } from "./edgeBlock.ts";

export const CLAUDE_EDGE_BLOCKED_ERROR_CODE = PROVIDER_EDGE_BLOCKED_ERROR_CODE;

// Waits before each automatic retry; the block usually clears within seconds.
export const CLAUDE_EDGE_BLOCK_RETRY_DELAYS_MS: ReadonlyArray<number> = [5_000, 15_000, 45_000];

// Sent as a synthetic prompt: Claude Code drops its API-error message from the
// model's history, so the conversation resumes after the last real exchange.
export const CLAUDE_EDGE_BLOCK_CONTINUATION_PROMPT =
  "Your previous request was blocked by a temporary network error before a response arrived. Continue the task from where you left off.";

export function isClaudeEdgeBlockedError(
  error: SDKAssistantMessageError,
  messageText: string,
): boolean {
  // Claude Code labels every 403 authentication_failed and keeps only the page <title>.
  return error === "authentication_failed" && isProviderEdgeBlockedText(messageText);
}

export function claudeEdgeBlockRetryWarning(input: {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
}): string {
  const delaySeconds = Math.ceil(input.delayMs / 1000);
  return `Request retry ${input.attempt}/${input.maxRetries} in ${delaySeconds}s (HTTP 403 Cloudflare block).`;
}

export function claudeEdgeBlockedMessage(retries: number): string {
  const retried =
    retries > 0
      ? `, still blocked after ${retries} automatic ${retries === 1 ? "retry" : "retries"}`
      : "";
  return `Anthropic's Cloudflare edge temporarily blocked the request (HTTP 403)${retried}. Your Claude login is fine; send a message to continue.`;
}
