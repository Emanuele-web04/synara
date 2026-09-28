import {
  DESKTOP_RENDERER_ERROR_MESSAGE_MAX_LENGTH,
  DESKTOP_RENDERER_ERROR_STACK_MAX_LENGTH,
  type DesktopRendererError,
} from "@synara/contracts";
import { redactDiagnosticText } from "@synara/shared/diagnosticsRedaction";

/** Stable and browser clients have no diagnostics bridge and attach no listeners. */
export function installRendererErrorDiagnostics(): (() => void) | undefined {
  const diagnostics = window.desktopBridge?.betaDiagnostics;
  if (!diagnostics) return undefined;
  const report = ({ message, stack }: DesktopRendererError): void => {
    // Error fields are writable at runtime, even when TypeScript declares strings.
    if (typeof message !== "string" || (stack !== undefined && typeof stack !== "string")) {
      message = "Renderer error details unavailable";
      stack = undefined;
    }
    if (!message) return;
    try {
      diagnostics.reportError({
        message: redactDiagnosticText(message, {
          maxLength: DESKTOP_RENDERER_ERROR_MESSAGE_MAX_LENGTH,
        }),
        ...(stack
          ? {
              stack: redactDiagnosticText(stack, {
                maxLength: DESKTOP_RENDERER_ERROR_STACK_MAX_LENGTH,
              }),
            }
          : {}),
      });
    } catch {
      // Diagnostics must never change exception handling or app behavior.
    }
  };
  const onError = (event: ErrorEvent): void => {
    try {
      report(
        event.error instanceof Error
          ? { message: event.error.message || event.error.name, stack: event.error.stack }
          : { message: event.message || "Unhandled renderer error" },
      );
    } catch {
      report({ message: "Renderer error details unavailable" });
    }
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    try {
      const reason: unknown = event.reason;
      if (reason instanceof Error)
        report({ message: reason.message || reason.name, stack: reason.stack });
      else
        report({
          message:
            typeof reason === "string" && reason
              ? reason
              : "Unhandled promise rejection (non-Error value)",
        });
    } catch {
      report({ message: "Renderer rejection details unavailable" });
    }
  };
  const dispose = (): void => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  try {
    diagnostics.rendererReady();
  } catch {
    dispose();
    return undefined;
  }
  return dispose;
}
