import {
  DESKTOP_RENDERER_ERROR_MESSAGE_MAX_LENGTH,
  DESKTOP_RENDERER_ERROR_STACK_MAX_LENGTH,
  type DesktopRendererError,
  type DesktopDiagnosticBreadcrumb,
  ORCHESTRATION_WS_METHODS,
} from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";

import {
  installRendererErrorDiagnostics,
  rendererRpcActivity,
  recordRendererActivity,
} from "./rendererErrorDiagnostics";

afterEach(() => vi.unstubAllGlobals());

function installTestDiagnostics() {
  const reports: DesktopRendererError[] = [];
  const activities: DesktopDiagnosticBreadcrumb[] = [];
  const target = Object.assign(new EventTarget(), {
    desktopBridge: {
      betaDiagnostics: {
        rendererReady: () => {},
        recordActivity: (breadcrumb: DesktopDiagnosticBreadcrumb) => activities.push(breadcrumb),
        reportError: (error: DesktopRendererError) => reports.push(error),
      },
    },
  });
  vi.stubGlobal("window", target);
  const dispose = installRendererErrorDiagnostics();
  return { reports, activities, target, dispose };
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

it("records fixed action categories without reading private RPC fields", () => {
  const { activities, target, dispose } = installTestDiagnostics();
  try {
    const params = {
      command: {
        type: "thread.turn.start",
        get message() {
          throw new Error("must not read prompt");
        },
        threadId: "private-id",
      },
    };
    const activity = rendererRpcActivity(ORCHESTRATION_WS_METHODS.dispatchCommand, params);
    expect(activity).toBe("chat.send");
    recordRendererActivity(activity!, "started");
    expect(rendererRpcActivity("arbitrary private method", params)).toBeUndefined();
    target.dispatchEvent(new Event("resize"));
    target.dispatchEvent(new Event("resize"));
    expect(activities).toEqual([
      { activity: "chat.send", phase: "started" },
      { activity: "window.resize", phase: "succeeded" },
    ]);
    dispose?.();
    target.dispatchEvent(new Event("resize"));
    expect(activities).toHaveLength(2);
  } finally {
    dispose?.();
  }
});

it("does not inspect RPC arguments or attach listeners without the Beta bridge", () => {
  const target = new EventTarget();
  const listen = vi.spyOn(target, "addEventListener");
  vi.stubGlobal("window", target);
  expect(installRendererErrorDiagnostics()).toBeUndefined();
  expect(
    rendererRpcActivity(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      get command() {
        throw new Error("must not inspect");
      },
    }),
  ).toBeUndefined();
  expect(listen).not.toHaveBeenCalled();
});

it("keeps handled failures harmless when diagnostics are absent or IPC rejects", async () => {
  const { reportHandledIssue } = await import("./rendererErrorDiagnostics");
  vi.stubGlobal("window", {});
  await expect(reportHandledIssue({ code: "voice.record.failed" })).resolves.toBeNull();
  vi.stubGlobal("window", {
    desktopBridge: {
      betaDiagnostics: { reportIssue: () => Promise.reject(new Error("IPC unavailable")) },
    },
  });
  await expect(reportHandledIssue({ code: "voice.record.failed" })).resolves.toBeNull();
});
