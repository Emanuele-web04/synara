import {
  DESKTOP_RENDERER_ERROR_MESSAGE_MAX_LENGTH,
  DESKTOP_RENDERER_ERROR_STACK_MAX_LENGTH,
  type DesktopRendererError,
} from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";

import { installRendererErrorDiagnostics } from "./rendererErrorDiagnostics";

afterEach(() => vi.unstubAllGlobals());

function installTestDiagnostics() {
  const reports: DesktopRendererError[] = [];
  const target = Object.assign(new EventTarget(), {
    desktopBridge: {
      betaDiagnostics: {
        rendererReady: () => {},
        reportError: (error: DesktopRendererError) => reports.push(error),
      },
    },
  });
  vi.stubGlobal("window", target);
  const dispose = installRendererErrorDiagnostics();
  return { reports, target, dispose };
}

it("does not throw a second renderer error when exception details have a throwing getter", () => {
  const { reports, target, dispose } = installTestDiagnostics();
  try {
    const error = new Error("Original renderer failure");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("Diagnostic accessor failure");
      },
    });
    target.dispatchEvent(Object.assign(new Event("error"), { error, message: error.message }));
    expect(reports).toEqual([{ message: "Renderer error details unavailable" }]);
  } finally {
    dispose?.();
  }
});

it.each([
  { event: "error", field: "message", value: { privateDetails: "do not serialize" } },
  { event: "error", field: "stack", value: 42 },
  { event: "unhandledrejection", field: "message", value: 42 },
  { event: "unhandledrejection", field: "stack", value: { privateDetails: "do not serialize" } },
])("keeps a $event report when Error.$field is not a string", ({ event, field, value }) => {
  const { reports, target, dispose } = installTestDiagnostics();
  try {
    const error = new Error("Original renderer failure");
    Object.defineProperty(error, field, { value });
    target.dispatchEvent(
      Object.assign(new Event(event), event === "error" ? { error } : { reason: error }),
    );
    expect(reports).toEqual([{ message: "Renderer error details unavailable" }]);
  } finally {
    dispose?.();
  }
});

it.each([
  { event: "error", field: "message", limit: DESKTOP_RENDERER_ERROR_MESSAGE_MAX_LENGTH },
  { event: "error", field: "stack", limit: DESKTOP_RENDERER_ERROR_STACK_MAX_LENGTH },
  {
    event: "unhandledrejection",
    field: "message",
    limit: DESKTOP_RENDERER_ERROR_MESSAGE_MAX_LENGTH,
  },
] as const)(
  "redacts a PEM block spanning the $event $field IPC limit",
  ({ event, field, limit }) => {
    const { reports, target, dispose } = installTestDiagnostics();
    try {
      // Short synthetic key lines evade the generic long-token rule if the PEM
      // footer is cut off before the shared redactor can recognize the block.
      const details =
        "Renderer failure:\n-----BEGIN PRIVATE KEY-----\n" +
        "SyntheticKeyPart+/12\n".repeat(limit) +
        "-----END PRIVATE KEY-----\n    at render (app.ts:10:5)";
      const error = new Error("Renderer failure");
      Object.defineProperty(error, field, { value: details });
      target.dispatchEvent(
        Object.assign(new Event(event), event === "error" ? { error } : { reason: details }),
      );
      expect(reports).toHaveLength(1);
      const output = reports[0]?.[field];
      expect(output).toContain("[redacted private key]");
      expect(output).not.toContain("SyntheticKeyPart");
      expect(output).toContain("at render (app.ts:10:5)");
      expect(output?.length).toBeLessThanOrEqual(limit);
    } finally {
      dispose?.();
    }
  },
);
