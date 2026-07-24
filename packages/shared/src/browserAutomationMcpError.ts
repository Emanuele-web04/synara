import {
  BrowserAutomationError,
  BrowserMcpToolErrorEnvelope,
  utf8ByteLength,
} from "@synara/contracts";
import { Schema } from "effect";

import { stableJsonStringify, type BrowserToolDefinition } from "./browserAutomationCatalogue";
import { makeBrowserAutomationError } from "./browserAutomationErrors";

const MAX_ERROR_TEXT_BYTES = 8 * 1024;

export interface BrowserMcpToolErrorResult {
  readonly isError: true;
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
}

export type BrowserMcpErrorDispatchState = "pre-dispatch" | "dispatched" | "unknown";
export type BrowserMcpErrorDecodeContext =
  | {
      readonly definition: BrowserToolDefinition;
      readonly dispatchState: BrowserMcpErrorDispatchState;
    }
  | { readonly dispatchState: "unknown" };

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length) {
    return false;
  }
  const expected = [...keys].sort();
  return actual.every((key, index) => key === expected[index]);
}

function malformedError(context: BrowserMcpErrorDecodeContext): BrowserAutomationError {
  const effectMayHaveCommitted =
    context.dispatchState === "unknown" ||
    (context.dispatchState === "dispatched" &&
      "definition" in context &&
      !context.definition.annotations.readOnlyHint);
  return makeBrowserAutomationError({
    code: "BrowserMalformedResponse",
    retryable: false,
    phase: "runtime",
    effectMayHaveCommitted,
  });
}

function readBrowserMcpErrorText(result: unknown): string | null {
  if (
    result === null ||
    typeof result !== "object" ||
    !hasExactKeys(result, ["content", "isError"]) ||
    (result as { readonly isError?: unknown }).isError !== true
  ) {
    return null;
  }

  const content = (result as { readonly content?: unknown }).content;
  if (!Array.isArray(content) || content.length !== 1) return null;

  const item = content[0];
  if (
    item === null ||
    typeof item !== "object" ||
    !hasExactKeys(item, ["text", "type"]) ||
    (item as { readonly type?: unknown }).type !== "text" ||
    typeof (item as { readonly text?: unknown }).text !== "string"
  ) {
    return null;
  }
  return (item as { readonly text: string }).text;
}

export function encodeBrowserMcpToolError(error: unknown): BrowserMcpToolErrorResult {
  const decoded = Schema.decodeUnknownSync(BrowserAutomationError)(error);
  const text = stableJsonStringify({ type: "synara_browser_error", version: 1, error: decoded });
  if (utf8ByteLength(text) > MAX_ERROR_TEXT_BYTES) {
    throw new RangeError("Browser MCP error envelope exceeds 8 KiB");
  }
  return { isError: true, content: [{ type: "text", text }] };
}

export function decodeBrowserMcpToolError(
  result: unknown,
  context: BrowserMcpErrorDecodeContext,
): BrowserAutomationError {
  try {
    const text = readBrowserMcpErrorText(result);
    if (text === null || utf8ByteLength(text) > MAX_ERROR_TEXT_BYTES) {
      return malformedError(context);
    }
    const raw = JSON.parse(text) as unknown;
    if (
      raw === null ||
      typeof raw !== "object" ||
      !hasExactKeys(raw, ["error", "type", "version"])
    ) {
      return malformedError(context);
    }
    const envelope = Schema.decodeUnknownSync(BrowserMcpToolErrorEnvelope)(raw);
    const error = envelope.error;
    if (
      !hasExactKeys(error, [
        "code",
        "effectMayHaveCommitted",
        "message",
        ...(error.operationId === undefined ? [] : ["operationId"]),
        "phase",
        "retryable",
        ...(error.tabId === undefined ? [] : ["tabId"]),
      ])
    ) {
      return malformedError(context);
    }
    return error;
  } catch {
    return malformedError(context);
  }
}
