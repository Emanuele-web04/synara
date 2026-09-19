// FILE: ComputerSetupRequiredCard.browser.tsx
// Purpose: Pin when the transcript's setup card stops asking the desktop how it is.
// Layer: Chat transcript UI regression test
//
// The card polls because the expected path is the user allowing the dialog
// macOS already put on screen, with nothing pressed in Synara — so it has to
// notice a grant landing on its own. But `computer.getStatus` engages the
// desktop backend, and a transcript card lives in the scrollback for the life
// of the tab. Polling it forever meant a conversation that once hit a denial
// kept a helper busy every ten seconds, long after the answer could change.

import type { ComputerStatusResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS } from "~/lib/serverReactQuery";
import { ConnectedComputerSetupRequiredCard } from "./ComputerSetupRequiredCard";

const getStatus = vi.hoisted(() => vi.fn());
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ computer: { getStatus } }),
  readNativeApi: () => ({ computer: { getStatus } }),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function status(overrides: Partial<ComputerStatusResult> = {}): ComputerStatusResult {
  return {
    computerId: "desktop",
    availability: { kind: "available", backend: "mac" },
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
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
    provisionable: true,
    ...overrides,
  };
}

function blockedStatus(): ComputerStatusResult {
  return status({
    availability: {
      kind: "permission-required",
      missing: ["accessibility"],
      message: "macOS is asking for Accessibility.",
      buildSignature: "adhoc",
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  getStatus.mockReset();
});

async function mountCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ConnectedComputerSetupRequiredCard missing={["accessibility"]} />
    </QueryClientProvider>,
  );
  return screen;
}

it("stops asking the desktop once the grants have landed", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getStatus.mockResolvedValue(status());

  const screen = await mountCard();
  await expect.poll(() => screen.getByText("Computer control is ready").elements().length).toBe(1);

  await vi.advanceTimersByTimeAsync(COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS * 6);
  expect(getStatus).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

it("keeps watching while the grant is still outstanding", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getStatus.mockResolvedValue(blockedStatus());

  const screen = await mountCard();
  await expect.poll(() => getStatus.mock.calls.length).toBe(1);

  await vi.advanceTimersByTimeAsync(COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS * 3);
  expect(getStatus.mock.calls.length).toBeGreaterThan(1);
  await screen.unmount();
});
