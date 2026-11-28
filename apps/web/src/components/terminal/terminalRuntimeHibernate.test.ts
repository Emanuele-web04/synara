import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEvent } from "@synara/contracts";

const hoisted = vi.hoisted(() => {
  const terminals: Array<{
    options: Record<string, unknown>;
    rows: number;
    cols: number;
    write: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  }> = [];
  const terminalEventSubscribers = new Map<string, Set<(event: TerminalEvent) => void>>();
  const wsStateListeners = new Set<(state: string) => void>();
  const observerInstances: Array<{
    callback: () => void;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const ackOutput = vi.fn().mockResolvedValue(undefined);
  const openApi = vi.fn().mockResolvedValue({
    threadId: "t1",
    terminalId: "default",
    cwd: "/tmp",
    status: "running",
    pid: 1234,
    history: "replayed-from-server\r\n",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  return {
    terminals,
    terminalEventSubscribers,
    wsStateListeners,
    observerInstances,
    ackOutput,
    openApi,
  };
});

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    options: Record<string, unknown>;
    rows = 24;
    cols = 80;
    unicode = { activeVersion: "6" };
    parser = {
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
      registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
      registerDcsHandler: vi.fn(() => ({ dispose: vi.fn() })),
      registerEscHandler: vi.fn(() => ({ dispose: vi.fn() })),
    };
    buffer = { active: { viewportY: 0, baseY: 0 } };
    write = vi.fn((_data: string, cb?: () => void) => cb?.());
    clear = vi.fn();
    refresh = vi.fn();
    dispose = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    getSelection = vi.fn(() => "");
    hasSelection = vi.fn(() => false);
    clearTextureAtlas = vi.fn();
    scrollToBottom = vi.fn();
    scrollToLine = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }));
    onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));

    constructor(opts: Record<string, unknown> = {}) {
      this.options = { ...opts };
      hoisted.terminals.push(this);
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    dispose = vi.fn();
  },
}));
vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-ligatures", () => ({ LigaturesAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("./terminalEventDispatcher", () => ({
  terminalEventDispatcher: {
    subscribe: (threadId: string, terminalId: string, fn: (event: TerminalEvent) => void) => {
      const key = `${threadId}::${terminalId}`;
      const set = hoisted.terminalEventSubscribers.get(key) ?? new Set();
      set.add(fn);
      hoisted.terminalEventSubscribers.set(key, set);
      return () => {
        set.delete(fn);
        if (set.size === 0) hoisted.terminalEventSubscribers.delete(key);
      };
    },
  },
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    terminal: {
      open: hoisted.openApi,
      ackOutput: hoisted.ackOutput,
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

vi.mock("../../wsTransport", () => ({
  addWsTransportStateListener: (listener: (state: string) => void) => {
    hoisted.wsStateListeners.add(listener);
    return () => {
      hoisted.wsStateListeners.delete(listener);
    };
  },
}));

vi.mock("./terminalFontSettle", () => ({
  waitForTerminalFontReady: () => new Promise(() => undefined),
}));

vi.mock("./terminalRuntimeAppearance", () => ({
  getTerminalBoldFontWeight: () => 600,
  getTerminalFontFamily: () => "monospace",
  getTerminalFontSizePx: () => 12,
  getTerminalFontWeight: () => 400,
  getTerminalMinimumContrastRatio: () => 1,
  isTerminalBackgroundTranslucent: () => false,
  terminalThemeFromApp: () => ({ background: "#000000", foreground: "#ffffff" }),
}));

import {
  attachRuntimeToContainer,
  createRuntimeEntry,
  detachRuntimeFromContainer,
  disposeRuntimeEntry,
  updateRuntimeViewState,
} from "./terminalRuntime";

interface FakeElement {
  id: string;
  className: string;
  dataset: Record<string, string>;
  style: { cssText: string };
  children: FakeElement[];
  parent: FakeElement | null;
  isConnected: boolean;
  listeners: Map<string, Set<EventListenerOrEventListenerObject>>;
  setAttribute: (name: string, value: string) => void;
  append: (...nodes: FakeElement[]) => void;
  remove: () => void;
  contains: (node: unknown) => boolean;
  closest: () => null;
  getBoundingClientRect: () => { width: number; height: number };
  addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => void;
}

function makeFakeElement(): FakeElement {
  const el: FakeElement = {
    id: "",
    className: "",
    dataset: {},
    style: { cssText: "" },
    children: [],
    parent: null,
    isConnected: false,
    listeners: new Map(),
    setAttribute: () => undefined,
    append(...nodes: FakeElement[]) {
      for (const node of nodes) {
        node.remove();
        node.parent = el;
        node.isConnected = el.isConnected;
        el.children.push(node);
      }
    },
    remove() {
      if (!el.parent) return;
      el.parent.children = el.parent.children.filter((child) => child !== el);
      el.parent = null;
      el.isConnected = false;
    },
    contains: (node) => node === el || el.children.includes(node as FakeElement),
    closest: () => null,
    getBoundingClientRect: () => ({ width: 800, height: 400 }),
    addEventListener(type, fn) {
      const set = el.listeners.get(type) ?? new Set();
      set.add(fn);
      el.listeners.set(type, set);
    },
    removeEventListener(type, fn) {
      el.listeners.get(type)?.delete(fn);
    },
  };
  return el;
}

function emitOutput(threadId: string, terminalId: string, data: string) {
  const key = `${threadId}::${terminalId}`;
  const event: TerminalEvent = {
    type: "output",
    threadId,
    terminalId,
    createdAt: "2026-01-01T00:00:00.000Z",
    data,
    byteLength: Buffer.byteLength(data, "utf8"),
  };
  for (const fn of hoisted.terminalEventSubscribers.get(key) ?? []) {
    fn(event);
  }
}

describe("terminalRuntime hibernate and resume", () => {
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  const origMutationObserver = globalThis.MutationObserver;
  const origResizeObserver = globalThis.ResizeObserver;

  let body: FakeElement;
  let documentElement: FakeElement;
  let rafId = 0;

  beforeEach(() => {
    hoisted.terminals.length = 0;
    hoisted.terminalEventSubscribers.clear();
    hoisted.wsStateListeners.clear();
    hoisted.observerInstances.length = 0;
    hoisted.ackOutput.mockClear();
    hoisted.openApi.mockClear();

    body = makeFakeElement();
    body.isConnected = true;
    documentElement = makeFakeElement();
    documentElement.isConnected = true;
    rafId = 0;

    const docListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const winListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

    const fakeDocument = {
      body,
      documentElement,
      hidden: false,
      activeElement: body,
      hasFocus: () => false,
      createElement: () => makeFakeElement(),
      getElementById: (id: string) => body.children.find((child) => child.id === id) ?? null,
      addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
        const set = docListeners.get(type) ?? new Set();
        set.add(fn);
        docListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
        docListeners.get(type)?.delete(fn);
      },
    };

    const fakeWindow = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: () => ++rafId,
      cancelAnimationFrame: () => undefined,
      addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
        const set = winListeners.get(type) ?? new Set();
        set.add(fn);
        winListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
        winListeners.get(type)?.delete(fn);
      },
    };

    Object.defineProperty(globalThis, "document", { value: fakeDocument, configurable: true });
    Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });

    globalThis.MutationObserver = class {
      callback: () => void;
      observe = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
      constructor(callback: () => void) {
        this.callback = callback;
        hoisted.observerInstances.push(this);
      }
    } as unknown as typeof MutationObserver;

    globalThis.ResizeObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", { value: origWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: origDocument, configurable: true });
    globalThis.MutationObserver = origMutationObserver;
    globalThis.ResizeObserver = origResizeObserver;
  });

  it("pauses writes and cursorBlink while hidden, ACKs server PTY, and replays buffered output on resume", async () => {
    const entry = createRuntimeEntry({
      runtimeKey: "t1::default",
      threadId: "t1",
      terminalId: "default",
      terminalLabel: "Terminal",
      cwd: "/tmp",
      callbacks: {
        onSessionExited: vi.fn(),
        onTerminalMetadataChange: vi.fn(),
        onTerminalActivityChange: vi.fn(),
      },
    });
    const container = makeFakeElement();
    body.append(container);
    attachRuntimeToContainer(
      entry,
      { autoFocus: false, isVisible: true },
      container as unknown as HTMLDivElement,
    );
    await Promise.resolve();

    const term = hoisted.terminals[0]!;
    expect(term.options.cursorBlink).toBe(true);
    term.write.mockClear();
    term.refresh.mockClear();
    hoisted.ackOutput.mockClear();

    // Hibernate (detach when switching threads)
    detachRuntimeFromContainer(entry);
    expect(term.options.cursorBlink).toBe(false);

    // PTY output arrives while parked/hidden: must NOT write to offscreen xterm DOM,
    // MUST immediately ACK backend PTY so background commands keep running.
    emitOutput("t1", "default", "bg-line-1\r\n");
    emitOutput("t1", "default", "bg-line-2\r\n");
    expect(term.write).not.toHaveBeenCalled();
    expect(hoisted.ackOutput).toHaveBeenCalledTimes(2);

    // Theme mutations while hidden must not refresh offscreen xterm DOM.
    hoisted.observerInstances[0]?.callback();
    expect(term.refresh).not.toHaveBeenCalled();

    // Resume (switch back to thread): restores cursorBlink and replays buffered output in one batch.
    attachRuntimeToContainer(
      entry,
      { autoFocus: false, isVisible: true },
      container as unknown as HTMLDivElement,
    );
    expect(term.options.cursorBlink).toBe(true);
    expect(term.write).toHaveBeenCalledWith("bg-line-1\r\nbg-line-2\r\n");

    // Clean disposal removes all listeners, observers, and DOM wrappers with zero leaks.
    disposeRuntimeEntry(entry);
    expect(hoisted.terminalEventSubscribers.size).toBe(0);
    expect(hoisted.wsStateListeners.size).toBe(0);
    expect(hoisted.observerInstances[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect((entry.wrapper as unknown as FakeElement).isConnected).toBe(false);
  });

  it("reconciles from server snapshot on resume when hidden output exceeds buffer cap", async () => {
    const entry = createRuntimeEntry({
      runtimeKey: "t2::default",
      threadId: "t2",
      terminalId: "default",
      terminalLabel: "Terminal",
      cwd: "/tmp",
      callbacks: {
        onSessionExited: vi.fn(),
        onTerminalMetadataChange: vi.fn(),
        onTerminalActivityChange: vi.fn(),
      },
    });
    const container = makeFakeElement();
    body.append(container);
    attachRuntimeToContainer(
      entry,
      { autoFocus: false, isVisible: true },
      container as unknown as HTMLDivElement,
    );
    await Promise.resolve();

    const term = hoisted.terminals[0]!;
    term.write.mockClear();
    hoisted.openApi.mockClear();

    // Hide (e.g., switched dock tab) and stream > 128 KiB
    updateRuntimeViewState(entry, { autoFocus: false, isVisible: false });
    emitOutput("t2", "default", "x".repeat(150_000));
    expect(term.write).not.toHaveBeenCalled();
    expect(entry.needsSnapshotReconcileOnShow).toBe(true);

    // Becoming visible triggers server snapshot reconciliation to restore full history
    updateRuntimeViewState(entry, { autoFocus: false, isVisible: true });
    expect(hoisted.openApi).toHaveBeenCalledTimes(1);

    disposeRuntimeEntry(entry);
  });
});
