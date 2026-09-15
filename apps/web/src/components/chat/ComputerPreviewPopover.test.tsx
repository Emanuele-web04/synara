// FILE: ComputerPreviewPopover.test.tsx
// Purpose: Guards what the preview popover renders for a given session phase;
//          hidden when no session is armed, open while live, and the chrome
//          (Stop, expand, close) it offers while an agent drives.
// Layer: Component rendering tests
// Depends on: ComputerPreviewPopover and React server rendering.
//
// Rendered to static markup like ComputerPanel.test.tsx: every side effect in
// the component lives in `useEffect`, so a server render exercises exactly the
// render-time phase and visibility decisions. The stores are stubbed rather
// than seeded for the same reason: zustand serves its initial state to
// `useSyncExternalStore`'s server snapshot.

import type { ThreadComputerState, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComputerPreviewPopover } from "./ComputerPreviewPopover";
import type { ComputerPreviewSession } from "./ComputerPreviewPopover.logic";

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const current: {
  session: ComputerPreviewSession | undefined;
  state: ThreadComputerState | undefined;
  autoOpenComputerPane: boolean;
} = vi.hoisted(() => ({
  session: undefined,
  state: undefined,
  autoOpenComputerPane: true,
}));

vi.mock("../../computerPreviewStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../computerPreviewStore")>();
  return {
    ...actual,
    useComputerPreviewStore: (selector: (store: unknown) => unknown) =>
      selector({
        sessionsByThreadId: current.session ? { [current.session.threadId]: current.session } : {},
        agentActiveByThreadId: {},
        markPreviewLive: vi.fn(),
        hidePreviewForTask: vi.fn(),
      }),
  };
});

vi.mock("../../computerStateStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../computerStateStore")>();
  return {
    ...actual,
    useComputerStateStore: (selector: (store: unknown) => unknown) =>
      selector({
        threadStatesByThreadId: current.state ? { [current.state.threadId]: current.state } : {},
        lastActionByThreadId: {},
      }),
  };
});

vi.mock("../../appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({
      settings: { autoOpenComputerPane: current.autoOpenComputerPane },
    }),
  };
});

const THREAD_ID = "thread-1" as ThreadId;

function threadState(overrides: Partial<ThreadComputerState> = {}): ThreadComputerState {
  return {
    threadId: THREAD_ID,
    version: 1,
    computerId: "desktop",
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
    windows: [],
    screenSize: { width: 5120, height: 2520 },
    agentActive: false,
    controlledByOtherThread: false,
    availability: { kind: "available" },
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    lastError: null,
    ...overrides,
  };
}

function session(phase: ComputerPreviewSession["phase"]): ComputerPreviewSession {
  return { threadId: THREAD_ID, phase };
}

function render(input?: {
  session?: ComputerPreviewSession;
  state?: ThreadComputerState;
  autoOpenComputerPane?: boolean;
}) {
  current.session = input?.session;
  current.state = input?.state;
  current.autoOpenComputerPane = input?.autoOpenComputerPane ?? true;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ComputerPreviewPopover threadId={THREAD_ID} onExpand={vi.fn()} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  current.session = undefined;
  current.state = undefined;
  current.autoOpenComputerPane = true;
});

describe("ComputerPreviewPopover", () => {
  it("renders nothing when the thread has no preview session", () => {
    expect(render()).toBe("");
  });

  it("renders nothing while the automatic preview is disabled", () => {
    expect(render({ session: session("live"), autoOpenComputerPane: false })).toBe("");
  });

  it("renders an armed session closed until the surface marks it live", () => {
    const markup = render({ session: session("armed") });
    expect(markup).toContain('role="region"');
    expect(markup).toContain("opacity-0");
  });

  it("renders a live session open with the desktop chrome", () => {
    const markup = render({ session: session("live"), state: threadState() });
    expect(markup).toContain("opacity-100");
    expect(markup).toContain("Computer");
    expect(markup).toContain("Open the Computer pane");
    expect(markup).toContain("Hide the computer preview for the rest of this task");
  });

  it("offers the pane's Stop while an agent is driving", () => {
    const markup = render({
      session: session("live"),
      state: threadState({ agentActive: true }),
    });
    expect(markup).toContain("Stop the agent controlling this computer");
  });

  it("shows the session's last action in the header", () => {
    const markup = render({
      session: { ...session("live"), lastActionLabel: "Type text" },
      state: threadState(),
    });
    expect(markup).toContain("Type text");
  });

  it("stays closed for hidden and ended sessions", () => {
    for (const phase of ["hidden-for-task", "ended"] as const) {
      const markup = render({ session: session(phase), state: threadState() });
      expect(markup).toContain("opacity-0");
      expect(markup).not.toContain("opacity-100");
    }
  });
});
