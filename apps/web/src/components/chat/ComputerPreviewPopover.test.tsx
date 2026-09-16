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
import type {
  ComputerPreviewCardSize,
  ComputerPreviewSession,
} from "./ComputerPreviewPopover.logic";

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const current: {
  session: ComputerPreviewSession | undefined;
  state: ThreadComputerState | undefined;
  autoOpenComputerPane: boolean;
  tapActive: boolean;
  tapFrameSize: { width: number; height: number } | null;
  stillsStreaming: boolean;
} = vi.hoisted(() => ({
  session: undefined,
  state: undefined,
  autoOpenComputerPane: true,
  tapActive: true,
  tapFrameSize: { width: 960, height: 600 },
  stillsStreaming: false,
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

vi.mock("../computer/useComputerPreviewTap", () => ({
  useComputerPreviewTap: () => ({
    active: current.tapActive,
    frameSize: current.tapFrameSize,
  }),
}));

vi.mock("../computer/useComputerImageStream", () => ({
  useComputerImageStream: () => ({
    status: current.stillsStreaming ? { kind: "streaming" } : { kind: "idle" },
    dimensions: null,
  }),
}));

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
  frame?: boolean;
  stills?: boolean;
  size?: ComputerPreviewCardSize;
  maxWidthPx?: number;
}) {
  current.session = input?.session;
  current.state = input?.state;
  current.autoOpenComputerPane = input?.autoOpenComputerPane ?? true;
  const withFrame = input?.frame ?? true;
  current.tapActive = withFrame;
  current.tapFrameSize = withFrame ? { width: 960, height: 600 } : null;
  current.stillsStreaming = input?.stills ?? false;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ComputerPreviewPopover
        threadId={THREAD_ID}
        size={input?.size}
        maxWidthPx={input?.maxWidthPx}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  current.session = undefined;
  current.state = undefined;
  current.autoOpenComputerPane = true;
  current.tapActive = true;
  current.tapFrameSize = { width: 960, height: 600 };
  current.stillsStreaming = false;
});

describe("ComputerPreviewPopover", () => {
  it("renders nothing when the thread has no preview session", () => {
    expect(render()).toBe("");
  });

  it("renders nothing while the automatic preview is disabled", () => {
    expect(render({ session: session("live"), autoOpenComputerPane: false })).toBe("");
  });

  it("renders an armed session closed with its canvas mounted for decode", () => {
    const markup = render({ session: session("armed"), frame: false });
    expect(markup).toContain('role="region"');
    expect(markup).toContain("opacity-0");
    expect(markup).toContain("<canvas");
  });

  it("renders a live session open with the desktop chrome", () => {
    const markup = render({ session: session("live"), state: threadState() });
    expect(markup).toContain("scale-100 opacity-100");
    expect(markup).toContain('aria-label="Computer preview"');
    expect(markup).toContain("960 / 600");
    // Compact is the default footprint: small and glanceable.
    expect(markup).toContain("width:288px");
    expect(markup).not.toContain("Open the Computer pane");
    expect(markup).toContain("Hide the computer preview for the rest of this task");
  });

  it("grows to the large footprint when the size setting asks for it", () => {
    const markup = render({
      session: session("live"),
      state: threadState(),
      size: "large",
      maxWidthPx: 560,
    });
    expect(markup).toContain("width:560px");
  });

  it("renders a live session closed until the first frame arrives", () => {
    const markup = render({ session: session("live"), state: threadState(), frame: false });
    expect(markup).toContain("opacity-0");
    expect(markup).not.toContain(" opacity-100");
    expect(markup).toContain("<canvas");
  });

  it("opens on the stills stream where the tap channel does not exist", () => {
    const markup = render({
      session: session("live"),
      state: threadState(),
      frame: false,
      stills: true,
    });
    expect(markup).toContain("opacity-100");
  });

  it("offers only close: the pane is disabled and stopping lives in the composer", () => {
    const markup = render({
      session: session("live"),
      state: threadState({ agentActive: true }),
    });
    expect(markup).not.toContain("Open the Computer pane");
    expect(markup).toContain("Hide the computer preview for the rest of this task");
    expect(markup).not.toContain("Stop the agent controlling");
  });

  it("shows the current live activity instead of a stale action", () => {
    const markup = render({
      session: { ...session("live"), lastActionLabel: "Type text" },
      state: threadState({ agentActive: true, activity: "Reading clipboard" }),
    });
    expect(markup).toContain("Reading clipboard");
    expect(markup).not.toContain("Type text");
  });

  it("stays closed for hidden and ended sessions", () => {
    for (const phase of ["hidden-for-task", "ended"] as const) {
      const markup = render({ session: session(phase), state: threadState() });
      expect(markup).toContain("opacity-0");
      expect(markup).not.toContain(" opacity-100");
    }
  });
});
