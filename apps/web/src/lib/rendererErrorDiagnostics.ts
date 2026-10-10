import {
  DESKTOP_RENDERER_ERROR_MESSAGE_MAX_LENGTH,
  DESKTOP_RENDERER_ERROR_STACK_MAX_LENGTH,
  type DesktopRendererError,
  type DesktopDiagnosticActivity,
  type DesktopDiagnosticBreadcrumb,
  type DesktopDiagnosticIssue,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@synara/contracts";
import { redactDiagnosticText } from "@synara/shared/diagnosticsRedaction";

export { diagnosticIssueReason } from "@synara/shared/diagnosticIssue";

export async function reportHandledIssue(issue: DesktopDiagnosticIssue): Promise<string | null> {
  try {
    if (typeof window === "undefined") return null;
    return (await window.desktopBridge?.betaDiagnostics?.reportIssue?.(issue)) ?? null;
  } catch {
    return null;
  }
}

/** Only fixed categories cross IPC; RPC payloads and identifiers are never serialized. */
export function rendererRpcActivity(
  method: string,
  params: unknown,
): DesktopDiagnosticActivity | undefined {
  try {
    if (typeof window === "undefined" || !window.desktopBridge?.betaDiagnostics?.recordActivity)
      return;
    switch (method) {
      case ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot:
        return "chat.open";
      case ORCHESTRATION_WS_METHODS.importThread:
      case ORCHESTRATION_WS_METHODS.importProject:
        return "project.import";
      case ORCHESTRATION_WS_METHODS.listProjectImports:
        return "project.import.catalog";
      case ORCHESTRATION_WS_METHODS.loadProjectImportHistory:
        return "project.import.preview";
      case ORCHESTRATION_WS_METHODS.reconcileProviderDelivery:
        return "chat.unblock";
      case WS_METHODS.projectsSearchEntries:
      case WS_METHODS.projectsSearchLocalEntries:
      case WS_METHODS.projectsSearchContent:
        return "workspace.search";
      case WS_METHODS.projectsReadFile:
        return "workspace.read";
      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const command = (params as { command?: { type?: unknown } } | undefined)?.command;
        switch (command?.type) {
          case "thread.turn.start":
            return "chat.send";
          case "thread.turn.interrupt":
            return "chat.stop";
          case "thread.meta.update":
            return "workspace.change";
          case "project.create":
            return "project.create";
        }
      }
    }
  } catch {
    // Malformed input and unavailable bridges must not affect RPC behavior.
  }
}

export function recordRendererActivity(
  activity: DesktopDiagnosticActivity,
  phase: DesktopDiagnosticBreadcrumb["phase"],
): void {
  try {
    if (typeof window !== "undefined")
      window.desktopBridge?.betaDiagnostics?.recordActivity?.({ activity, phase });
  } catch {
    // Diagnostics must never affect the action being observed.
  }
}

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
  let lastResize = -Infinity;
  const onResize = (): void => {
    const now = Date.now();
    if (now - lastResize < 1_000) return;
    lastResize = now;
    recordRendererActivity("window.resize", "succeeded");
  };
  const dispose = (): void => {
    window.removeEventListener("resize", onResize);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
  window.addEventListener("resize", onResize);
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
