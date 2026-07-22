import {
  BrowserAutomationError,
  BrowserAutomationErrorMessages,
  BrowserFixedAutomationErrorInvariants,
  type BrowserAutomationErrorInput,
  type BrowserMcpToolErrorEnvelope,
} from "@synara/contracts";
import { Schema } from "effect";

type BrowserFixedAutomationErrorCode = keyof typeof BrowserFixedAutomationErrorInvariants;
type BrowserContextualAutomationErrorInput = Exclude<
  BrowserAutomationErrorInput,
  { readonly code: BrowserFixedAutomationErrorCode }
>;

const getFixedBrowserErrorInvariant = (code: BrowserAutomationErrorInput["code"]) =>
  BrowserFixedAutomationErrorInvariants[code as BrowserFixedAutomationErrorCode];

export const makeBrowserAutomationError = (
  input: BrowserAutomationErrorInput,
): BrowserAutomationError => {
  const fixedInvariant = getFixedBrowserErrorInvariant(input.code);
  const contextualInput = input as BrowserContextualAutomationErrorInput;
  const invariant = fixedInvariant ?? {
    retryable: contextualInput.retryable,
    phase: contextualInput.phase,
    effectMayHaveCommitted: contextualInput.effectMayHaveCommitted,
  };

  return Schema.decodeUnknownSync(BrowserAutomationError)({
    code: input.code,
    message: BrowserAutomationErrorMessages[input.code],
    ...invariant,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
  });
};

export const makeBrowserMcpToolErrorEnvelope = (
  input: BrowserAutomationErrorInput,
): BrowserMcpToolErrorEnvelope => ({
  type: "synara_browser_error",
  version: 1,
  error: makeBrowserAutomationError(input),
});
