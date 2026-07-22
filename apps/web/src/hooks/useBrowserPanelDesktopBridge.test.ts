// FILE: useBrowserPanelDesktopBridge.test.ts
// Purpose: Characterize the shared desktop browser-panel menu and open-request subscriptions.
// Layer: Web hook test

import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface EffectSlot {
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
    current?: (...args: never[]) => unknown;
    value?: (...args: never[]) => unknown;
  }

  let slots: EffectSlot[] = [];
  let cursor = 0;
  const nextSlot = () => {
    const slot = (slots[cursor] ??= {});
    cursor += 1;
    return slot;
  };
  // oxlint-disable-next-line consistent-function-scoping
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      for (const slot of slots) slot.cleanup?.();
      slots = [];
      cursor = 0;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = nextSlot();
      if (depsEqual(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
    useEffectEvent<T extends (...args: never[]) => unknown>(callback: T): T {
      const slot = nextSlot();
      slot.current = callback;
      slot.value ??= ((...args: never[]) => slot.current?.(...args)) as T;
      return slot.value as T;
    },
  };
});

vi.mock("react", () => ({
  useEffect: reactHarness.useEffect,
  useEffectEvent: reactHarness.useEffectEvent,
}));

import { useBrowserPanelDesktopBridge } from "./useBrowserPanelDesktopBridge";

interface DesktopBridgeHarness {
  menuListener: ((action: string) => void) | null;
  openListener: ((payload: { threadId: ThreadId }) => void) | null;
  unsubscribeMenu: ReturnType<typeof vi.fn>;
  unsubscribeOpen: ReturnType<typeof vi.fn>;
  onMenuAction: ReturnType<typeof vi.fn>;
  onOpenRequest: ReturnType<typeof vi.fn>;
}

function createDesktopBridgeHarness(): DesktopBridgeHarness {
  const harness: DesktopBridgeHarness = {
    menuListener: null,
    openListener: null,
    unsubscribeMenu: vi.fn(),
    unsubscribeOpen: vi.fn(),
    onMenuAction: vi.fn(),
    onOpenRequest: vi.fn(),
  };
  harness.onMenuAction.mockImplementation((listener: (action: string) => void) => {
    harness.menuListener = listener;
    return harness.unsubscribeMenu;
  });
  harness.onOpenRequest.mockImplementation(
    (listener: (payload: { threadId: ThreadId }) => void) => {
      harness.openListener = listener;
      return harness.unsubscribeOpen;
    },
  );
  return harness;
}

function render(input: { onToggle: (() => void) | null; onOpen: (() => void) | null }) {
  reactHarness.beginRender();
  useBrowserPanelDesktopBridge(input);
}

beforeEach(() => {
  reactHarness.reset();
  vi.unstubAllGlobals();
});

describe("useBrowserPanelDesktopBridge", () => {
  it("routes only the browser menu action and delivers the requested thread", () => {
    const bridge = createDesktopBridgeHarness();
    vi.stubGlobal("window", {
      desktopBridge: {
        onMenuAction: bridge.onMenuAction,
        browser: { onBrowserUseOpenPanelRequest: bridge.onOpenRequest },
      },
    });
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const requestedThreadId = ThreadId.makeUnsafe("thread-requested-by-agent");

    render({ onToggle, onOpen });
    bridge.menuListener?.("open-settings");
    bridge.menuListener?.("toggle-browser");
    bridge.openListener?.({ threadId: requestedThreadId });

    expect(onToggle).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(requestedThreadId);
  });

  it("keeps subscriptions stable, invokes the latest callbacks, and unsubscribes when inactive", () => {
    const bridge = createDesktopBridgeHarness();
    vi.stubGlobal("window", {
      desktopBridge: {
        onMenuAction: bridge.onMenuAction,
        browser: { onBrowserUseOpenPanelRequest: bridge.onOpenRequest },
      },
    });

    const firstToggle = vi.fn();
    const firstOpen = vi.fn();
    const latestToggle = vi.fn();
    const latestOpen = vi.fn();
    const requestedThreadId = ThreadId.makeUnsafe("thread-latest-handler");
    render({ onToggle: firstToggle, onOpen: firstOpen });
    render({ onToggle: latestToggle, onOpen: latestOpen });

    expect(bridge.onMenuAction).toHaveBeenCalledOnce();
    expect(bridge.onOpenRequest).toHaveBeenCalledOnce();
    expect(bridge.unsubscribeMenu).not.toHaveBeenCalled();
    expect(bridge.unsubscribeOpen).not.toHaveBeenCalled();
    bridge.menuListener?.("toggle-browser");
    bridge.openListener?.({ threadId: requestedThreadId });
    expect(firstToggle).not.toHaveBeenCalled();
    expect(firstOpen).not.toHaveBeenCalled();
    expect(latestToggle).toHaveBeenCalledOnce();
    expect(latestOpen).toHaveBeenCalledExactlyOnceWith(requestedThreadId);

    render({ onToggle: null, onOpen: null });
    expect(bridge.unsubscribeMenu).toHaveBeenCalledOnce();
    expect(bridge.unsubscribeOpen).toHaveBeenCalledOnce();
  });

  it("does not subscribe outside the desktop bridge", () => {
    vi.stubGlobal("window", {});

    expect(() => render({ onToggle: vi.fn(), onOpen: vi.fn() })).not.toThrow();
  });
});
