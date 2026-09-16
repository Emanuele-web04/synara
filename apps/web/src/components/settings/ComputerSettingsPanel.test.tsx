// FILE: ComputerSettingsPanel.test.tsx
// Purpose: Guards what the Computer settings panel tells the user about the
//          desktop backend — the honest ones, the blocked ones, and the rows it
//          must not render on a backend where they would be inert.
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

import type { AppSettingsBinding } from "~/appSettings";
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

function binding(): AppSettingsBinding {
  return {
    settings: { autoOpenComputerPane: true, computerControlEnabled: true },
    defaults: { autoOpenComputerPane: true, computerControlEnabled: false },
    updateSettings: vi.fn(),
  } as unknown as AppSettingsBinding;
}

function render(input: { readonly status?: ComputerStatusResult; readonly active?: boolean }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (input.status) queryClient.setQueryData(serverQueryKeys.computerStatus(), input.status);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ComputerSettingsPanel {...binding()} active={input.active ?? true} />
    </QueryClientProvider>,
  );
}

describe("ComputerSettingsPanel", () => {
  it("renders nothing while the panel is not the active one", () => {
    // The status query is gated on the same flag; a panel nobody is looking at
    // must not poll a backend awake.
    expect(render({ status: status(), active: false })).toBe("");
  });

  it("names the backend rather than the raw identifier", () => {
    expect(render({ status: status() })).toContain("macOS desktop");
    expect(
      render({ status: status({ availability: { kind: "available", backend: "kwin" } }) }),
    ).toContain("KWin plugin (KDE)");
  });

  it("asks to check access before a shipped helper has actually connected", () => {
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
    expect(markup).not.toContain("Computer control available");
    expect(markup).not.toContain("Capabilities");
    expect(markup).toContain("Set up");
  });

  it("reads out the split focus and raise abilities", () => {
    const markup = render({ status: status() });
    expect(markup).toContain("keyboard focus");
    expect(markup).toContain("window raising");
  });

  it("drops screen capture from the abilities when the OS is withholding it", () => {
    // capture is a capability; captureAvailable is live health. Listing "screen
    // capture" on a blind desktop is the panel claiming something the machine
    // cannot do.
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
    expect(markup).not.toContain("screen capture");
    expect(markup).toContain("Screen capture is not allowed yet");
  });

  it("names the withheld grants and offers Set up", () => {
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
    expect(markup).toContain("Set up");
    expect(markup).toContain("not allowed yet");
    expect(markup).toContain("Accessibility");
  });

  it("offers the pane auto-open switch on every backend", () => {
    // The preview is wanted on the visible desktop too: stills-only mode
    // already keeps interactive off there, so the switch controls a real
    // feature — watching the agent's view inside the app.
    expect(render({ status: status() })).toContain("Open automatically");
    expect(
      render({
        status: status({
          availability: { kind: "available", backend: "nested-kwin" },
          capabilities: capabilities({ visibleDesktop: false }),
        }),
      }),
    ).toContain("Open automatically");
  });

  it("offers a Computer control switch with approval and Stop guardrails", () => {
    const markup = render({ status: status() });
    expect(markup).toContain("Computer control");
    expect(markup).toContain("Let the agent use the desktop in any chat");
    expect(markup).toContain("Approval gates and Stop still apply");
    expect(markup).not.toContain("/computer-use");
    expect(markup).not.toContain("How agents use the desktop");
  });

  it("offers a preview size choice next to the automatic preview", () => {
    const markup = render({ status: status() });
    expect(markup).toContain("Preview size");
    expect(markup).toContain("Compact");
    expect(markup).toContain("Large");
  });
});
