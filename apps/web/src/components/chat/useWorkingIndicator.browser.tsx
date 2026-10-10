// FILE: useWorkingIndicator.browser.tsx
// Purpose: Browser regressions for the working-indicator hooks: the delayed
//          "Starting <provider>…" label and the work-start latch.
// Layer: Web browser tests
// Depends on: useWorkingIndicator and a real React render loop.

import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import {
  STARTING_PROVIDER_LABEL_DELAY_MS,
  useLatchedActiveWorkStartedAt,
  useStartingProviderName,
} from "./useWorkingIndicator";

interface StartingProps {
  readonly isWorking: boolean;
  readonly isConnecting: boolean;
  readonly isRunning: boolean;
  readonly providerName: string;
  readonly threadId?: ThreadId | null;
}

const THREAD_A = "11111111-1111-4111-8111-111111111111" as ThreadId;
const THREAD_B = "22222222-2222-4222-8222-222222222222" as ThreadId;

function renderStarting(initialProps: StartingProps) {
  return renderHook((props?: StartingProps) => useStartingProviderName(props ?? initialProps), {
    initialProps,
  });
}

describe("useStartingProviderName", () => {
  it("stays null for a fast connect and never flashes the label", async () => {
    const hook = await renderStarting({
      isWorking: true,
      isConnecting: true,
      isRunning: false,
      providerName: "Codex",
      threadId: THREAD_A,
    });
    expect(hook.result.current).toBeNull();
    await hook.rerender({
      isWorking: true,
      isConnecting: false,
      isRunning: true,
      providerName: "Codex",
      threadId: THREAD_A,
    });
    await new Promise<void>((resolve) =>
      setTimeout(resolve, STARTING_PROVIDER_LABEL_DELAY_MS + 300),
    );
    expect(hook.result.current).toBeNull();
    await hook.unmount();
  });

  it("shows the label after the delay and holds it through the ready gap", async () => {
    const hook = await renderStarting({
      isWorking: true,
      isConnecting: true,
      isRunning: false,
      providerName: "Codex",
      threadId: THREAD_A,
    });
    await vi.waitFor(
      () => {
        expect(hook.result.current).toBe("Codex");
      },
      { timeout: STARTING_PROVIDER_LABEL_DELAY_MS + 2_000, interval: 16 },
    );
    // connecting → ready: the label holds until the turn is running.
    await hook.rerender({
      isWorking: true,
      isConnecting: false,
      isRunning: false,
      providerName: "Codex",
      threadId: THREAD_A,
    });
    expect(hook.result.current).toBe("Codex");
    // running: back to the plain Thinking shimmer.
    await hook.rerender({
      isWorking: true,
      isConnecting: false,
      isRunning: true,
      providerName: "Codex",
      threadId: THREAD_A,
    });
    await vi.waitFor(() => {
      expect(hook.result.current).toBeNull();
    });
    await hook.unmount();
  });

  it("resets the delayed label when the thread changes", async () => {
    const hook = await renderStarting({
      isWorking: true,
      isConnecting: true,
      isRunning: false,
      providerName: "Codex",
      threadId: THREAD_A,
    });
    await vi.waitFor(
      () => {
        expect(hook.result.current).toBe("Codex");
      },
      { timeout: STARTING_PROVIDER_LABEL_DELAY_MS + 2_000, interval: 16 },
    );
    // A connecting span on another thread must not inherit the armed label.
    await hook.rerender({
      isWorking: true,
      isConnecting: true,
      isRunning: false,
      providerName: "Codex",
      threadId: THREAD_B,
    });
    expect(hook.result.current).toBeNull();
    await hook.unmount();
  });
});

describe("useLatchedActiveWorkStartedAt", () => {
  it("latches the first non-null start for a working span", async () => {
    const threadId = "11111111-1111-4111-8111-111111111111" as never;
    const hook = await renderHook(
      (props?: { isWorking: boolean; candidate: string | null }) =>
        useLatchedActiveWorkStartedAt({
          isWorking: props?.isWorking ?? true,
          threadId,
          candidate: props?.candidate ?? null,
        }),
      { initialProps: { isWorking: true, candidate: "2026-04-13T00:00:00.000Z" } },
    );
    expect(hook.result.current).toBe("2026-04-13T00:00:00.000Z");
    await hook.rerender({ isWorking: true, candidate: "2026-04-13T00:00:05.000Z" });
    expect(hook.result.current).toBe("2026-04-13T00:00:00.000Z");
    await hook.rerender({ isWorking: false, candidate: "2026-04-13T00:00:05.000Z" });
    expect(hook.result.current).toBeNull();
    await hook.unmount();
  });
});
