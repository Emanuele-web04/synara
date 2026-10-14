// FILE: ComputerSettingsPanel.test.tsx
// Purpose: Guards what the Computer settings panel tells the user about the
//          desktop backend — the one attention row, the calm ready state, and
//          the chrome it must not grow back (a manual re-arm, spec-sheet rows,
//          duplicate permission surfaces).
// Layer: Component rendering tests
// Depends on: ComputerSettingsPanel and React server rendering.
//
// Rendered to static markup with the status query primed, which is enough for
// every question worth asking of this panel: it is a read-out, and what it
// reads out is decided at render time. Interaction (pressing Set up) belongs to
// `useProvisionComputer.test.tsx`, which owns that mutation.

import type { ComputerStatusResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AppSettingsSchema,
  applyLocalAppSettingsPatch,
  resolveAgentCursorColors,
  type AppSettings,
  type AppSettingsBinding,
} from "~/appSettings";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ComputerSettingsPanel } from "./ComputerSettingsPanel";

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function capabilities(overrides: Partial<ComputerStatusResult["capabilities"]> = {}) {
  return {
    windows: true,
    windowBounds: true,
    stacking: true,
    capture: true,
    input: true,
    clipboard: true,
    focus: true,
    raise: true,
    ghostCursor: true,
    visibleDesktop: true,
    ...overrides,
  };
}

function status(overrides: Partial<ComputerStatusResult> = {}): ComputerStatusResult {
  return {
    computerId: "desktop",
    availability: { kind: "available", backend: "mac" },
    capabilities: capabilities(),
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    ...overrides,
  };
}

function binding(overrides: Partial<AppSettings> = {}): AppSettingsBinding {
  return {
    settings: { autoOpenComputerPane: true, computerControlEnabled: true, ...overrides },
    defaults: { autoOpenComputerPane: true, computerControlEnabled: false },
    updateSettings: vi.fn(),
  } as unknown as AppSettingsBinding;
}

function render(input: {
  readonly status?: ComputerStatusResult;
  readonly active?: boolean;
  readonly settings?: Partial<AppSettings>;
  readonly platform?: string;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (input.status) queryClient.setQueryData(serverQueryKeys.computerStatus(), input.status);
  if (input.platform)
    queryClient.setQueryData(serverQueryKeys.environment(), { platform: { os: input.platform } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ComputerSettingsPanel {...binding(input.settings)} active={input.active ?? true} />
    </QueryClientProvider>,
  );
}

describe("ComputerSettingsPanel", () => {
  it("labels Windows as beta and explains interruption limits without promising Mac safeguards", () => {
    const markup = render({
      status: status({ availability: { kind: "available", backend: "cua" } }),
      platform: "windows",
    });
    expect(markup).toContain("Computer control (Windows beta)");
    expect(markup).toContain("stopping an action already in progress is not yet reliable");
    expect(markup).not.toContain("shares your Mac desktop");
    expect(markup).not.toContain("Input Monitoring is granted");
  });

  it("renders nothing while the panel is not the active one", () => {
    // The status query is gated on the same flag; a panel nobody is looking at
    // must not poll a backend awake.
    expect(render({ status: status(), active: false })).toBe("");
  });

  it("keeps the surface calm while the desktop is ready", () => {
    const markup = render({ status: status() });
    expect(markup).toContain("Connected to the desktop");
    expect(markup).not.toContain("Set up");
    expect(markup).not.toContain("Refresh");
    expect(markup).not.toContain("Desktop backend");
    expect(markup).not.toContain("Background typing is limited");
    expect(markup).not.toContain("Capabilities");
  });

  it("asks to check access while nothing has confirmed the grants", () => {
    // After a restart the backend is idle, and without the OS's own grant
    // answer an idle backend is not evidence that anything works.
    const markup = render({
      status: status({
        health: {
          status: "unavailable",
          consecutiveFailures: 0,
          reconnects: 0,
          captureAvailable: false,
        },
      }),
    });
    expect(markup).toContain("Computer access has not been checked");
    expect(markup).toContain("Set up");
  });

  it("names the withheld grants once and offers Set up", () => {
    const markup = render({
      status: status({
        availability: {
          kind: "permission-required",
          missing: ["accessibility", "screenRecording"],
          message: "macOS is asking for Accessibility.",
          buildSignature: "adhoc",
        },
      }),
    });
    expect(markup).toContain("Computer control needs Accessibility and Screen Recording");
    expect(markup).toContain("macOS is asking for Accessibility.");
    expect(markup).toContain("Set up");
    // The one attention row names the grants; the old second row ("… are not
    // allowed yet") is gone.
    expect(markup.match(/Computer control needs/g) ?? []).toHaveLength(1);
    expect(markup).not.toContain("not allowed yet");
  });

  it("keeps the blind-desktop copy honest and fixable", () => {
    const markup = render({
      status: status({
        health: {
          status: "connected",
          consecutiveFailures: 0,
          reconnects: 0,
          captureAvailable: false,
        },
      }),
    });
    expect(markup).toContain("Screen capture is not allowed yet");
    expect(markup).toContain("Screen Recording");
    expect(markup).toContain("cannot see it");
    expect(markup).toContain("Set up");
    // Never claims a live system dialog that may not exist.
    expect(markup).not.toContain("macOS is asking");
    expect(markup).not.toContain("dialog is open");
    // A blind desktop never gets an abilities read-out that claims capture.
    expect(markup).not.toContain("screen capture");
  });

  it("reports a reconnect in flight without offering a manual re-arm", () => {
    const markup = render({
      status: status({
        health: {
          status: "reconnecting",
          consecutiveFailures: 1,
          reconnects: 1,
          captureAvailable: true,
        },
      }),
    });
    expect(markup).toContain("Reconnecting to the desktop");
    expect(markup).toContain("Reconnected once since startup.");
  });

  it("describes observation-only Cua without promising Mac input or treating idle readiness as input authorization", () => {
    const markup = render({
      status: status({
        availability: { kind: "available", backend: "cua" },
        capabilities: capabilities({
          input: false,
          focus: false,
          raise: false,
          ghostCursor: false,
        }),
      }),
    });
    expect(markup).toContain("Cua 0.28.2");
    expect(markup).toContain("native desktop input is unavailable");
    expect(markup).toContain("verified browser runtime");
    expect(markup).not.toContain("shares your Mac");
    expect(markup).not.toContain("macOS desktop");
  });

  describe("agent cursor colors", () => {
    it("keeps the cursor stock by default and hides the color editors", () => {
      const markup = render({ status: status() });
      expect(markup).toContain("Cursor colors");
      expect(markup).toContain("Stock");
      expect(markup).toContain("Custom");
      // Stock is the zero-override default: no fill/rim editor renders and no
      // stored color is read out.
      expect(markup).not.toContain("Fill color");
      expect(markup).not.toContain("Rim color");
      expect(markup).not.toContain("data-swatch");
    });

    it("round-trips custom colors through the settings store", () => {
      const defaults = AppSettingsSchema.makeUnsafe({});
      // The default is stock with no overrides stored.
      expect(defaults.agentCursorColorMode).toBe("stock");
      expect(defaults.agentCursorFillColor).toBe("");
      expect(defaults.agentCursorRimColor).toBe("");
      expect(resolveAgentCursorColors(defaults)).toBeNull();

      const stored = applyLocalAppSettingsPatch(defaults, {
        agentCursorColorMode: "custom",
        agentCursorFillColor: "#AABBCC",
        agentCursorRimColor: "not-a-color",
      });
      expect(stored.agentCursorColorMode).toBe("custom");
      expect(stored.agentCursorFillColor).toBe("#aabbcc");
      // A value that is not a complete hex color never becomes a preference.
      expect(stored.agentCursorRimColor).toBe("");
      expect(resolveAgentCursorColors(stored)).toEqual({ fill: "#aabbcc" });

      // Stock means zero overrides even when colors are still remembered for
      // a later switch back to custom.
      const backToStock = applyLocalAppSettingsPatch(stored, {
        agentCursorColorMode: "stock",
      });
      expect(backToStock.agentCursorFillColor).toBe("#aabbcc");
      expect(resolveAgentCursorColors(backToStock)).toBeNull();
    });
  });
});
