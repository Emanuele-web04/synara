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
import type { ComputerImageStreamStatus } from "../computer/useComputerImageStream";

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const current: {
  session: ComputerPreviewSession | undefined;
  state: ThreadComputerState | undefined;
  autoOpenComputerPane: boolean;
  tapActive: boolean;
  tapFrameSize: { width: number; height: number } | null;
  stillsStreaming: boolean;
  streamStatus: ComputerImageStreamStatus | undefined;
  floating: { x: number; y: number } | undefined;
} = vi.hoisted(() => ({
  session: undefined,
  state: undefined,
  autoOpenComputerPane: true,
  tapActive: true,
  tapFrameSize: { width: 960, height: 600 },
  stillsStreaming: false,
  streamStatus: undefined,
  floating: undefined,
}));

vi.mock("../../computerPreviewStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../computerPreviewStore")>();
  return {
    ...actual,
    useComputerPreviewStore: (selector: (store: unknown) => unknown) =>
      selector({
        sessionsByThreadId: current.session ? { [current.session.threadId]: current.session } : {},
        agentActiveByThreadId: {},
        floatingByThreadId: current.floating
          ? { [current.session?.threadId ?? THREAD_ID]: current.floating }
          : {},
        markPreviewLive: vi.fn(),
        hidePreviewForTask: vi.fn(),
        setPreviewFloating: vi.fn(),
        movePreviewFloating: vi.fn(),
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
    status:
      current.streamStatus ?? (current.stillsStreaming ? { kind: "streaming" } : { kind: "idle" }),
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
  /** Tap decoded a frame then went silent: size kept, no longer active. */
  tapQuiet?: boolean;
  stills?: boolean;
  streamStatus?: ComputerImageStreamStatus;
  size?: ComputerPreviewCardSize;
  maxWidthPx?: number;
  floating?: { x: number; y: number };
}) {
  current.session = input?.session;
  current.state = input?.state;
  current.autoOpenComputerPane = input?.autoOpenComputerPane ?? true;
  const tapQuiet = input?.tapQuiet ?? false;
  const withFrame = (input?.frame ?? true) || tapQuiet;
  current.tapActive = withFrame && !tapQuiet;
  current.tapFrameSize = withFrame ? { width: 960, height: 600 } : null;
  current.stillsStreaming = input?.stills ?? false;
  current.streamStatus = input?.streamStatus;
  current.floating = input?.floating;
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
  current.streamStatus = undefined;
  current.floating = undefined;
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

  it.each([
    [
      { kind: "error", message: "The preview connection failed." },
      "The preview connection failed.",
    ],
    [{ kind: "unsupported" }, "This browser cannot decode desktop frames."],
  ] as const)(
    "shows a first-frame %s without waiting for a decoded image",
    (streamStatus, message) => {
      const markup = render({
        session: session("live"),
        state: threadState(),
        frame: false,
        streamStatus,
      });
      expect(markup).toContain("scale-100 opacity-100");
      expect(markup).toContain(message);
      expect(markup).toContain('role="status"');
      expect(markup).toContain("<canvas");
    },
  );

  it("does not reopen a dismissed preview because its first frame failed", () => {
    const markup = render({
      session: session("hidden-for-task"),
      state: threadState(),
      frame: false,
      streamStatus: { kind: "error", message: "The preview connection failed." },
    });
    expect(markup).not.toContain("scale-100 opacity-100");
  });

  it("shows the waiting state, never a picture, when no window frame exists yet", () => {
    // The stills source is window/tab-scoped and the server publishes nothing
    // without a target, so the card must present the calm waiting label
    // instead of drawing anything.
    const markup = render({ session: session("live"), state: threadState(), frame: false });
    expect(markup).toContain("Waiting for the window the agent is using…");
    expect(markup).not.toContain("Waiting for the desktop");
  });

  it("holds the quiet tap's last frame without the waiting label", () => {
    // Once a frame decoded, a source going quiet keeps showing it: the card
    // stays open on the held frame's own aspect with no empty-state label
    // pasted over a live picture.
    const markup = render({ session: session("live"), state: threadState(), tapQuiet: true });
    expect(markup).toContain("scale-100 opacity-100");
    expect(markup).toContain("960 / 600");
    expect(markup).not.toContain("Waiting for the window");
  });

  it("marks the status pill with a static dot, never an animated orb", () => {
    // The live indicator is a plain 6px dot — no ping ring, no colored orb
    // pulsing while the agent works.
    const markup = render({
      session: session("live"),
      state: threadState({ agentActive: true }),
    });
    expect(markup).toContain("Live");
    expect(markup).not.toContain("animate-ping");
    expect(markup).not.toContain("violet");
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

  it("offers pop-out while docked and dock while floating", () => {
    const docked = render({ session: session("live"), state: threadState() });
    expect(docked).toContain("Float the computer preview as a draggable window");
    expect(docked).not.toContain("fixed z-50");

    const floating = render({
      session: session("live"),
      state: threadState(),
      floating: { x: 120, y: 80 },
    });
    expect(floating).toContain("Dock the computer preview back into the chat rail");
    expect(floating).not.toContain("Float the computer preview");
    expect(floating).toContain("fixed z-50");
    expect(floating).toContain("left:120px");
    expect(floating).toContain("top:80px");
  });
});
