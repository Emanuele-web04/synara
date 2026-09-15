import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { synaraHostTarget } from "./betterwrightHostTarget";

const mocks = vi.hoisted(() => ({
  openConnection: vi.fn(),
}));
vi.mock("./betterwrightConnection", () => ({
  openBetterwrightConnection: mocks.openConnection,
}));

let contents: WebContents;

const fakeConnection = (provider: object) => {
  const close = vi.fn(async (_cancel = true) => {});
  let closing: Promise<void> | undefined;
  return {
    provider,
    get closed() {
      return closing !== undefined;
    },
    close: (cancel = true) => (closing ??= Promise.resolve(close(cancel)).then(() => undefined)),
    recordedClose: close,
  };
};

beforeEach(() => {
  vi.resetAllMocks();
  contents = {
    getBackgroundThrottling: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    isDestroyed: vi.fn(),
    id: 42,
    session: {
      setProxy: vi.fn(async () => {}),
      closeAllConnections: vi.fn(async () => {}),
    },
  } as unknown as WebContents;
  vi.mocked(contents.getBackgroundThrottling).mockReturnValue(false);
  vi.mocked(contents.isDestroyed).mockReturnValue(false);
});

describe("synaraHostTarget", () => {
  it("vends an independent capability transport per connect", async () => {
    mocks.openConnection
      .mockResolvedValueOnce(fakeConnection({ cdpUrl: "ws://127.0.0.1:1/browser" }))
      .mockResolvedValueOnce(fakeConnection({ cdpUrl: "ws://127.0.0.1:2/browser" }));
    const target = synaraHostTarget(contents);
    const first = await target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    const second = await target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    expect(first.provider).toEqual({ cdpUrl: "ws://127.0.0.1:1/browser" });
    expect(second.provider).toEqual({ cdpUrl: "ws://127.0.0.1:2/browser" });
    expect(mocks.openConnection).toHaveBeenCalledTimes(2);
  });

  it("passes the cookie-import capability and approved uploads through to the transport", async () => {
    const expectAgentInput = vi.fn();
    mocks.openConnection.mockResolvedValue(fakeConnection({}));
    const target = synaraHostTarget(contents, {
      cookieImport: true,
      uploadFiles: ["/abs/upload.bin"],
      expectAgentInput: expectAgentInput as never,
    });
    await target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    expect(mocks.openConnection).toHaveBeenCalledWith(
      contents,
      undefined,
      ["/abs/upload.bin"],
      true,
      expectAgentInput,
    );
  });

  it("refuses to vend a transport after interruption", async () => {
    const controller = new AbortController();
    const target = synaraHostTarget(contents, { signal: controller.signal });
    controller.abort();
    await expect(target.connect({ proxyUrl: "socks5://127.0.0.1:9" })).rejects.toThrow(
      "interrupted",
    );
    expect(mocks.openConnection).not.toHaveBeenCalled();
  });

  it("reports transport closure through the leased connection", async () => {
    const conn = fakeConnection({});
    mocks.openConnection.mockResolvedValue(conn);
    const target = synaraHostTarget(contents);
    const leased = await target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    expect(leased.closed).toBe(false);
    await leased.close();
    expect(leased.closed).toBe(true);
    // Lease rotation drains gracefully; abort paths cancel via revokeAll(true).
    expect(conn.recordedClose).toHaveBeenCalledWith(false);
  });

  it("configures the supplied proxy before opening the transport", async () => {
    const session = contents.session as unknown as {
      setProxy: ReturnType<typeof vi.fn>;
      closeAllConnections: ReturnType<typeof vi.fn>;
    };
    mocks.openConnection.mockResolvedValue(fakeConnection({}));
    const target = synaraHostTarget(contents);
    await target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    expect(session.setProxy).toHaveBeenCalledWith({
      proxyRules: "socks5://127.0.0.1:9",
      proxyBypassRules: "<-loopback>",
    });
    expect(session.closeAllConnections).toHaveBeenCalledOnce();
  });

  it("refuses to vend a transport for a destroyed tab", async () => {
    vi.mocked(contents.isDestroyed).mockReturnValue(true);
    const target = synaraHostTarget(contents);
    await expect(target.connect({ proxyUrl: "socks5://127.0.0.1:9" })).rejects.toThrow(
      "unavailable",
    );
    expect(mocks.openConnection).not.toHaveBeenCalled();
  });

  it("cancels an in-flight lease when revokeAll wins the race", async () => {
    let resolveOpening!: (conn: ReturnType<typeof fakeConnection>) => void;
    const opening = new Promise<ReturnType<typeof fakeConnection>>((resolve) => {
      resolveOpening = resolve;
    });
    mocks.openConnection.mockReturnValue(opening);
    const target = synaraHostTarget(contents);
    const connectPromise = target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    await vi.waitFor(() => expect(mocks.openConnection).toHaveBeenCalledOnce());
    const revoked = target.revokeAll(true);
    const conn = fakeConnection({});
    resolveOpening(conn);
    await expect(connectPromise).rejects.toThrow("interrupted");
    await revoked;
    expect(conn.recordedClose).toHaveBeenCalledWith(true);
  });

  it("revokeAll drains every live transport with the caller's cancel flag", async () => {
    const first = fakeConnection({});
    const second = fakeConnection({});
    mocks.openConnection.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const target = synaraHostTarget(contents);
    await target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    await target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    await target.revokeAll(true);
    expect(first.recordedClose).toHaveBeenCalledWith(true);
    expect(second.recordedClose).toHaveBeenCalledWith(true);
    await target.revokeAll(false);
    expect(first.recordedClose).toHaveBeenCalledTimes(1);
    expect(second.recordedClose).toHaveBeenCalledTimes(1);
  });

  it("run() holds background throttling off for the operation and restores it", async () => {
    vi.mocked(contents.getBackgroundThrottling).mockReturnValue(true);
    const signal = new AbortController().signal;
    const target = synaraHostTarget(contents, { signal });
    const result = await target.run(async (received) => {
      expect(received).toBe(signal);
      expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
      return { ok: true, result: "done" };
    });
    expect(result).toEqual({ ok: true, result: "done" });
    expect(vi.mocked(contents.setBackgroundThrottling).mock.calls).toEqual([[false], [true]]);
  });

  it("run() rejects when the tab is gone and skips the throttle restore", async () => {
    vi.mocked(contents.isDestroyed).mockReturnValue(true);
    const target = synaraHostTarget(contents);
    await expect(target.run(async () => ({ ok: true, result: null }))).rejects.toThrow(
      "unavailable",
    );
    expect(contents.setBackgroundThrottling).not.toHaveBeenCalled();
  });
});
