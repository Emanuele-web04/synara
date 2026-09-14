// FILE: ComputerScreenRecordingCopy.test.tsx
// Purpose: Guards the Screen Recording blind-desktop copy — it names the grant
//          and the cannot-see state without claiming a live system dialog.
// Layer: Component rendering tests (pure, no TCC/Electron/timers).

import type { ComputerStatusResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AppSettingsBinding } from "~/appSettings";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ComputerSettingsPanel } from "./ComputerSettingsPanel";

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function binding(): AppSettingsBinding {
  return {
    settings: { autoOpenComputerPane: true, computerControlEnabled: true },
    defaults: { autoOpenComputerPane: true, computerControlEnabled: false },
    updateSettings: vi.fn(),
  } as unknown as AppSettingsBinding;
}

function blindMacStatus(): ComputerStatusResult {
  return {
    computerId: "desktop",
    availability: { kind: "available", backend: "mac" },
    capabilities: {
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
    },
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: false },
  };
}

function renderPanel(status: ComputerStatusResult) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.computerStatus(), status);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ComputerSettingsPanel {...binding()} active />
    </QueryClientProvider>,
  );
}

describe("Computer Screen Recording copy", () => {
  it("names Screen Recording and the cannot-see state without a live-dialog claim", () => {
    const markup = renderPanel(blindMacStatus());
    expect(markup).toContain("Screen Recording");
    expect(markup).toContain("cannot see it");
    expect(markup).not.toContain("macOS is asking");
    expect(markup).not.toContain("live dialog");
    expect(markup).not.toContain("dialog is open");
  });
});
