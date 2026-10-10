import { describe, expect, it } from "vitest";
import { cuaActionDiagnosticMessage, parseCuaActionDiagnostics } from "./cuaActionDiagnostics";

describe("persisted native action diagnostics", () => {
  it("keeps finite measured scroll evidence without trusting prose", () => {
    expect(
      parseCuaActionDiagnostics({
        diagnostics: { scroll_delta_y: -120.5, observation: "fresh-frame", message: "private" },
      }),
    ).toEqual({ scroll_delta_y: -120.5, observation: "fresh-frame" });
    expect(
      parseCuaActionDiagnostics({
        diagnostics: { scroll_delta_y: Infinity, observation: "private window title" },
      }),
    ).toBeUndefined();
  });

  it("retains actionable native evidence without app content or raw error messages", () => {
    const diagnostics = parseCuaActionDiagnostics({
      message: "secret selected text",
      diagnostics: {
        delivery_path: "ax",
        actuator: "ax_press",
        focus_mutation: "none",
        restore_status: "not-needed",
        error_code: "ax_dispatch_failed",
        ax_error: -25204,
        prior_pid: 123,
        prior_window_id: 456,
        message: "secret selected text",
        title: "Private window",
        value: "password",
      },
    });
    expect(diagnostics).toEqual({
      delivery_path: "ax",
      actuator: "ax_press",
      focus_mutation: "none",
      restore_status: "not-needed",
      error_code: "ax_dispatch_failed",
      ax_error: -25204,
      prior_pid: 123,
      prior_window_id: 456,
    });
    expect(cuaActionDiagnosticMessage(diagnostics!)).toBe(
      "The accessibility actuator reported a native error.",
    );
  });

  it.each([
    null,
    [],
    {},
    { diagnostics: [] },
    {
      diagnostics: {
        actuator: "private field",
        error_code: "secret_token",
        delivery_path: "arbitrary",
        restore_status: "secret",
        focus_mutation: "password",
        ax_error: NaN,
        prior_pid: -1,
        prior_window_id: 2 ** 40,
      },
    },
  ])("drops malformed or unrecognized diagnostic content: %j", (value) => {
    expect(parseCuaActionDiagnostics(value)).toBeUndefined();
  });

  it("keeps useful partial evidence and rejects noninteger identity values", () => {
    expect(
      parseCuaActionDiagnostics({
        diagnostics: {
          restore_status: "failed",
          prior_pid: 1.5,
          prior_window_id: "12",
          ax_error: Infinity,
        },
      }),
    ).toEqual({ restore_status: "failed" });
  });
});
