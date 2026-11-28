import { EventEmitter } from "node:events";
import type { Session } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerBrowserHybridPasskeys } from "./browserHybridPasskeys";

const ui = vi.hoisted(() => ({
  focused: vi.fn(),
  partition: vi.fn(),
  contents: vi.fn(),
  create: vi.fn(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: new EventEmitter(),
    session: { fromPartition: ui.partition },
    webContents: { fromFrame: ui.contents },
    WebContentsView: EventEmitter,
    BrowserWindow: class {
      static getFocusedWindow = ui.focused;
      constructor(options: unknown) {
        return ui.create(options);
      }
    },
  };
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("process", { ...process, platform: "darwin" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture() {
  const target = Object.assign(new EventEmitter(), { setWebAuthnHybridEnabled: vi.fn() });
  const frame = {
    origin: "https://signin.example",
    url: "https://signin.example/login",
    detached: false,
  };
  const page = Object.assign(new EventEmitter(), {
    session: target,
    mainFrame: frame,
    isDestroyed: () => false,
    isFocused: () => true,
    focus: vi.fn(),
  });
  const owner = Object.assign(new EventEmitter(), {
    webContents: page,
    isDestroyed: () => false,
    isVisible: () => true,
    focus: vi.fn(),
  });
  const renderer = Object.assign(new EventEmitter(), {
    getURL: () => documentUrl,
    setWindowOpenHandler: vi.fn(),
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue(undefined),
  });
  let documentUrl = "";
  const sheet = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    destroy: vi.fn(),
    show: vi.fn(),
    setContentProtection: vi.fn(),
    webContents: renderer,
    loadURL: vi.fn(async (url: string) => {
      documentUrl = url;
    }),
  });
  ui.partition.mockReturnValue(target);
  ui.contents.mockReturnValue(page);
  ui.focused.mockReturnValue(owner);
  ui.create.mockReturnValue(sheet);
  const human = vi.fn(() => true);
  const dispose = registerBrowserHybridPasskeys(target as unknown as Session, human);
  const details = {
    requestId: "fixture",
    relyingPartyId: "signin.example",
    origin: frame.origin,
    frame,
    qr: "FIDO:/123456789",
  };
  const request = (overrides: object = {}) => {
    const cancel = vi.fn();
    target.emit("webauthn-hybrid-qr", {}, { ...details, ...overrides }, cancel);
    return cancel;
  };
  return { target, page, owner, sheet, renderer, frame, human, dispose, request, details };
}

it("requires a human-owned focused main frame at the exact secure origin before opening a sheet", () => {
  const f = fixture();
  try {
    expect(f.target.setWebAuthnHybridEnabled).toHaveBeenCalledWith(true);
    expect(f.request({ frame: { ...f.frame } })).toHaveBeenCalledOnce();
    expect(f.request({ origin: "https://other.example" })).toHaveBeenCalledOnce();
    f.frame.origin = "http://remote.example";
    f.frame.url = f.frame.origin;
    expect(f.request({ origin: f.frame.origin })).toHaveBeenCalledOnce();
    f.frame.origin = "https://signin.example";
    f.frame.url = f.frame.origin;
    f.human.mockReturnValue(false);
    expect(f.request()).toHaveBeenCalledOnce();
    expect(ui.create).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
  expect(f.target.listenerCount("webauthn-hybrid-qr")).toBe(0);
  expect(f.target.setWebAuthnHybridEnabled).toHaveBeenLastCalledWith(false);
});

it("cancels once without drawing a QR if tab ownership changes while loading or after display", async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    let finishLoad!: () => void;
    f.sheet.loadURL.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
    );
    const first = f.request();
    f.human.mockReturnValue(false);
    finishLoad();
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledOnce();
    expect(f.renderer.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(f.sheet.show).not.toHaveBeenCalled();

    f.human.mockReturnValue(true);
    const second = f.request({ requestId: "second" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sheet.show).toHaveBeenCalledOnce();
    expect(f.sheet.setContentProtection).toHaveBeenCalledWith(true);
    expect(f.sheet.loadURL.mock.lastCall![0]).not.toContain("FIDO");
    expect(f.sheet.loadURL.mock.lastCall![0]).not.toContain("signin.example");
    expect(f.request({ requestId: "competing" })).toHaveBeenCalledOnce();
    f.human.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(250);
    f.sheet.emit("closed");
    f.page.emit("destroyed");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

it("matches native completion after the frame disappears and hands focus back before the account picker", async () => {
  const f = fixture();
  try {
    const first = f.request();
    await vi.waitFor(() => expect(f.sheet.show).toHaveBeenCalledOnce());
    f.target.emit(
      "webauthn-hybrid-status",
      {},
      { ...f.details, requestId: "other", status: "closed" },
    );
    expect(f.sheet.destroy).not.toHaveBeenCalled();
    f.target.emit("webauthn-hybrid-status", {}, { ...f.details, frame: null, status: "closed" });
    expect(f.sheet.destroy).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    const replacement = f.request({ requestId: "replacement" });
    const account = vi.fn(() => expect(f.page.focus).toHaveBeenCalledOnce());
    f.target.on("select-webauthn-account", account);
    f.target.emit("select-webauthn-account", {}, { frame: f.frame });
    expect(account).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    expect(f.sheet.destroy).toHaveBeenCalledTimes(2);
  } finally {
    f.dispose();
  }
});
