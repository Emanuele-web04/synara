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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    const retainFocusAfterInput = vi.fn(() => true);
    mocks.openConnection.mockResolvedValue(fakeConnection({}));
    const target = synaraHostTarget(contents, {
      cookieImport: true,
      uploadFiles: ["/abs/upload.bin"],
      expectAgentInput: expectAgentInput as never,
      retainFocusAfterInput,
    });
    await target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    expect(mocks.openConnection).toHaveBeenCalledWith(
      contents,
      undefined,
      ["/abs/upload.bin"],
      true,
      expectAgentInput,
      retainFocusAfterInput,
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
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:9",
      proxyBypassRules: "<-loopback>",
    });
    expect(session.closeAllConnections).toHaveBeenCalledOnce();
  });

  it("rotates the proxy only after the old transport and session drain", async () => {
    const first = fakeConnection({});
    const gate = deferred<void>();
    first.recordedClose.mockReturnValueOnce(gate.promise);
    mocks.openConnection.mockResolvedValueOnce(first).mockResolvedValueOnce(fakeConnection({}));
    const target = synaraHostTarget(contents);
    await target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    const rotating = target.connect({ proxyUrl: "socks5://127.0.0.1:10" });
    await vi.waitFor(() => expect(first.recordedClose).toHaveBeenCalledWith(false));
    expect(mocks.openConnection).toHaveBeenCalledTimes(1);
    expect(contents.session.setProxy).toHaveBeenCalledTimes(1);
    gate.resolve();
    await rotating;
    expect(contents.session.setProxy).toHaveBeenLastCalledWith({
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:10",
      proxyBypassRules: "<-loopback>",
    });
    expect(contents.session.closeAllConnections).toHaveBeenCalledTimes(2);
    await target.revokeAll();
  });

  it("serializes concurrent connects without losing the session lease", async () => {
    mocks.openConnection.mockImplementation(async () => fakeConnection({}));
    const target = synaraHostTarget(contents);
    await Promise.all([
      target.connect({ proxyUrl: "socks5://127.0.0.1:9" }),
      target.connect({ proxyUrl: "socks5://127.0.0.1:10" }),
    ]);
    await target.revokeAll();
    const next = synaraHostTarget(contents);
    await next.connect({ proxyUrl: "socks5://127.0.0.1:11" });
    await next.revokeAll();
  });

  it("retains its session turn through rotation while another tab is queued", async () => {
    mocks.openConnection.mockImplementation(async () => fakeConnection({}));
    const target = synaraHostTarget(contents);
    await target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    const sibling = synaraHostTarget(contents);
    let siblingConnected = false;
    const queued = sibling.connect({ proxyUrl: "socks5://127.0.0.1:11" }).then(() => {
      siblingConnected = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rotating = target.connect({ proxyUrl: "socks5://127.0.0.1:10" });
    await vi.waitFor(() => expect(mocks.openConnection).toHaveBeenCalledTimes(2));
    expect(siblingConnected).toBe(false);
    await rotating;
    expect(contents.session.setProxy).toHaveBeenLastCalledWith({
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:10",
      proxyBypassRules: "<-loopback>",
    });
    await target.revokeAll();
    await queued;
    expect(siblingConnected).toBe(true);
    await sibling.revokeAll();
  });

  it.each(["failure", "abort"])("releases a queued sibling after rotation %s", async (failure) => {
    mocks.openConnection.mockImplementation(async () => fakeConnection({}));
    const target = synaraHostTarget(contents);
    await target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    const sibling = synaraHostTarget(contents);
    const queued = sibling.connect({ proxyUrl: "socks5://127.0.0.1:11" });
    const gate = deferred<void>();
    vi.mocked(contents.session.setProxy).mockImplementationOnce(async () => {
      await gate.promise;
      if (failure === "failure") throw new Error("rotation failed");
    });
    const rotating = target.connect({ proxyUrl: "socks5://127.0.0.1:10" });
    const rejected = expect(rotating).rejects.toThrow(
      failure === "abort" ? "interrupted" : "rotation failed",
    );
    await vi.waitFor(() => expect(contents.session.setProxy).toHaveBeenCalledTimes(2));
    const revoked = failure === "abort" ? target.revokeAll() : undefined;
    gate.resolve();
    await rejected;
    await revoked;
    await queued;
    expect(mocks.openConnection).toHaveBeenCalledTimes(2);
    expect(contents.session.setProxy).toHaveBeenNthCalledWith(3, { mode: "system" });
    await target.revokeAll();
    expect(contents.session.setProxy).toHaveBeenLastCalledWith({
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:11",
      proxyBypassRules: "<-loopback>",
    });
    await sibling.revokeAll();
  });

  it("revokes during proxy setup before opening a transport", async () => {
    const gate = deferred<void>();
    vi.mocked(contents.session.setProxy).mockReturnValueOnce(gate.promise);
    const target = synaraHostTarget(contents);
    const connecting = target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    const interrupted = expect(connecting).rejects.toThrow("interrupted");
    await vi.waitFor(() => expect(contents.session.setProxy).toHaveBeenCalledOnce());
    const revoked = target.revokeAll();
    gate.resolve();
    await interrupted;
    await revoked;
    expect(mocks.openConnection).not.toHaveBeenCalled();
    expect(contents.session.setProxy).toHaveBeenLastCalledWith({ mode: "system" });
    await expect(target.connect({ proxyUrl: "socks5://127.0.0.1:10" })).rejects.toThrow(
      "interrupted",
    );
  });

  it("does not wait for a stalled open during revocation or vend its late result", async () => {
    const gate = deferred<ReturnType<typeof fakeConnection>>();
    mocks.openConnection.mockReturnValueOnce(gate.promise);
    const target = synaraHostTarget(contents);
    const connecting = target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    const interrupted = expect(connecting).rejects.toThrow("interrupted");
    await vi.waitFor(() => expect(mocks.openConnection).toHaveBeenCalledOnce());
    await target.revokeAll();
    expect(contents.session.setProxy).toHaveBeenLastCalledWith({ mode: "system" });
    const connection = fakeConnection({});
    gate.resolve(connection);
    await interrupted;
    expect(connection.recordedClose).toHaveBeenCalledWith(true);
  });

  it("releases the proxy when opening the transport fails", async () => {
    mocks.openConnection.mockRejectedValueOnce(new Error("open failed"));
    const target = synaraHostTarget(contents);
    await expect(target.connect({ proxyUrl: "socks5://127.0.0.1:9" })).rejects.toThrow(
      "open failed",
    );
    expect(contents.session.setProxy).toHaveBeenLastCalledWith({ mode: "system" });
    mocks.openConnection.mockResolvedValueOnce(fakeConnection({}));
    const next = synaraHostTarget(contents);
    await next.connect({ proxyUrl: "socks5://127.0.0.1:10" });
    await next.revokeAll();
  });

  it("does not reuse a stale lease after another target recovers failed cleanup", async () => {
    mocks.openConnection.mockRejectedValueOnce(new Error("open failed"));
    vi.mocked(contents.session.closeAllConnections)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("restore failed"));
    const original = synaraHostTarget(contents);
    await expect(original.connect({ proxyUrl: "socks5://127.0.0.1:9" })).rejects.toThrow(
      "restore failed",
    );
    mocks.openConnection.mockImplementation(async () => fakeConnection({}));
    const next = synaraHostTarget(contents);
    await next.connect({ proxyUrl: "socks5://127.0.0.1:10" });
    const waiting = original.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.openConnection).toHaveBeenCalledTimes(2);
    await next.revokeAll();
    await waiting;
    expect(mocks.openConnection).toHaveBeenCalledTimes(3);
    await original.revokeAll();
  });

  it("revokes a target waiting for another tab without waiting for that tab to finish", async () => {
    mocks.openConnection.mockImplementation(async () => fakeConnection({}));
    const first = synaraHostTarget(contents);
    await first.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    const waiting = synaraHostTarget(contents);
    const connecting = waiting.connect({ proxyUrl: "socks5://127.0.0.1:10" });
    const rejected = expect(connecting).rejects.toThrow("interrupted");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await waiting.revokeAll();
    await rejected;
    expect(mocks.openConnection).toHaveBeenCalledOnce();
    expect(contents.session.setProxy).toHaveBeenCalledOnce();
    await first.revokeAll();
    const last = synaraHostTarget(contents);
    await last.connect({ proxyUrl: "socks5://127.0.0.1:11" });
    await last.revokeAll();
  });

  it("checks aborts again after asynchronous setup and restores the proxy", async () => {
    const controller = new AbortController();
    const gate = deferred<void>();
    vi.mocked(contents.session.setProxy).mockReturnValueOnce(gate.promise);
    const target = synaraHostTarget(contents, { signal: controller.signal });
    const connecting = target.connect({ proxyUrl: "socks5://127.0.0.1:9" });
    const interrupted = expect(connecting).rejects.toThrow("interrupted");
    await vi.waitFor(() => expect(contents.session.setProxy).toHaveBeenCalledOnce());
    controller.abort();
    gate.resolve();
    await interrupted;
    expect(mocks.openConnection).not.toHaveBeenCalled();
    expect(contents.session.setProxy).toHaveBeenLastCalledWith({ mode: "system" });
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
