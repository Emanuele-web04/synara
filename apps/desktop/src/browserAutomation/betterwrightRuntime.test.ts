import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { BrowserAutomationErrorMessages } from "@synara/contracts";
import { runBetterwright } from "./betterwrightRuntime";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  browserClose: vi.fn(),
  connectionClose: vi.fn(),
  openConnection: vi.fn(),
  constructedOptions: { current: undefined as unknown },
}));
vi.mock("betterwright", () => ({
  BetterWright: class {
    conn: { close(): Promise<void> } | undefined;
    constructor(
      public options: {
        hostTarget: { connect(arg: unknown): Promise<{ close(): Promise<void> }> };
      },
    ) {
      mocks.constructedOptions.current = options;
    }
    run = async (code: string, runOptions?: unknown) => {
      this.conn ??= await this.options.hostTarget.connect({
        proxyUrl: "socks5://127.0.0.1:1",
      });
      return mocks.run(code, runOptions);
    };
    close = async () => {
      await this.conn?.close().catch(() => {});
      return mocks.browserClose();
    };
  },
  NetworkPolicy: class {},
}));
vi.mock("./betterwrightConnection", () => ({
  openBetterwrightConnection: mocks.openConnection,
}));

vi.mock("betterwright/guard-proxy", () => ({
  createGuardProxy: () => ({ ensure: async () => 4321, close: async () => {} }),
}));

let contents: WebContents;

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
  mocks.browserClose.mockResolvedValue(undefined);
  mocks.connectionClose.mockResolvedValue(undefined);
  mocks.constructedOptions.current = undefined;
  mocks.openConnection.mockImplementation(async () => {
    let closing: Promise<void> | undefined;
    return {
      provider: {},
      get closed() {
        return closing !== undefined;
      },
      close: (cancel = true) => (closing ??= Promise.resolve(mocks.connectionClose(cancel))),
    };
  });
  vi.mocked(contents.getBackgroundThrottling).mockReturnValue(true);
  vi.mocked(contents.isDestroyed).mockReturnValue(false);
});

const run = () =>
  runBetterwright({
    home: "/synthetic",
    contents,
    code: "return null",
    timeoutMs: 30000,
    signal: new AbortController().signal,
  });

describe("Betterwright runtime errors", () => {
  it("waits for worker shutdown even when CDP revocation fails", async () => {
    let finish!: () => void;
    mocks.run.mockResolvedValue({ ok: true, result: null });
    mocks.browserClose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    mocks.connectionClose.mockRejectedValueOnce(new Error("revoke failed"));
    let settled = false;
    const running = run().finally(() => {
      settled = true;
    });
    const failed = expect(running).rejects.toThrow("revoke failed");
    await vi.waitFor(() => expect(mocks.browserClose).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.connectionClose).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finish();
    await failed;
  });
  it.each([true, false])(
    "restores the original throttling policy (%s) after the worker drains",
    async (throttled) => {
      vi.mocked(contents.getBackgroundThrottling).mockReturnValue(throttled);
      mocks.run.mockImplementation(async () => {
        if (throttled) expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
        return { ok: true, result: null };
      });
      mocks.connectionClose.mockImplementation(async () => {
        if (throttled) expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
      });
      await run();
      expect(vi.mocked(contents.setBackgroundThrottling).mock.calls).toEqual(
        throttled ? [[false], [true]] : [],
      );
    },
  );

  it("restores throttling when connection setup fails", async () => {
    mocks.openConnection.mockRejectedValue(new Error("setup failed"));
    await expect(run()).rejects.toThrow("setup failed");
    expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it("does not restore a destroyed renderer after a worker error", async () => {
    mocks.run.mockImplementation(async () => {
      vi.mocked(contents.isDestroyed).mockReturnValue(true);
      throw new Error("renderer closed");
    });
    await expect(run()).rejects.toThrow("renderer closed");
    expect(vi.mocked(contents.setBackgroundThrottling).mock.calls).toEqual([[false]]);
  });
  it.each([
    "credential form not-found: private-page-label. Use explicit targets.",
    "credential form ambiguous: private-page-label. Use explicit targets.",
    "credential form detection found no password field.",
    "credential form submit detection failed: private-page-label.",
  ])("returns only fixed guidance for credential target errors (%s)", async (error) => {
    mocks.run.mockResolvedValue({ ok: false, error });
    await expect(run()).rejects.toMatchObject({
      browserError: {
        code: "BrowserCredentialTargetRequired",
        effectMayHaveCommitted: true,
        message: expect.stringContaining("sign in manually"),
      },
    });
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
    expect(mocks.browserClose).toHaveBeenCalledOnce();
  });

  it("preserves fixed guidance when a script requests password access", async () => {
    mocks.run.mockResolvedValue({
      ok: false,
      error: BrowserAutomationErrorMessages.BrowserCredentialUseUnavailable,
    });
    await expect(run()).rejects.toMatchObject({
      browserError: {
        code: "BrowserCredentialUseUnavailable",
        retryable: false,
        effectMayHaveCommitted: true,
      },
    });
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
  });

  it.each(["private-password", { secret: "private-password" }, undefined])(
    "never forwards unknown worker errors",
    async (error) => {
      mocks.run.mockResolvedValue({ ok: false, error });
      const failure = await run().catch((value: unknown) => value);
      expect(failure).toMatchObject({ browserError: { code: "BrowserEvaluationFailed" } });
      expect(JSON.stringify(failure)).not.toContain("private-password");
      expect(mocks.connectionClose).toHaveBeenCalledWith(true);
      expect(mocks.browserClose).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "getByRole",
    "getByLabel",
    "getByText",
    "getByPlaceholder",
    "getByTestId",
    "locator",
    "document",
    "window",
    "location",
    "waitForTimeout",
  ])("explains the sandbox API for an unavailable %s global", async (name) => {
    mocks.run.mockResolvedValue({ ok: false, error: `${name} is not defined` });
    await expect(run()).rejects.toMatchObject({
      browserError: {
        code: "BrowserScriptApiUnavailable",
        message: BrowserAutomationErrorMessages.BrowserScriptApiUnavailable,
        retryable: false,
        effectMayHaveCommitted: true,
      },
    });
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
  });

  it.each([
    ["setTimeout", "wait with locator.waitFor()"],
    ["setInterval", "page.waitForTimeout(ms)"],
    ["requestAnimationFrame", "page.waitForFunction()"],
    ["navigator", "inside page.evaluate"],
    ["getByRole", "call page.getByRole(...)"],
    ["require", "without Node.js APIs"],
  ])("fails fast with a specific cause for the unavailable %s global", async (name, hint) => {
    mocks.run.mockResolvedValue({ ok: false, error: `${name} is not defined` });
    await expect(run()).rejects.toMatchObject({
      browserError: {
        code: "BrowserScriptApiUnavailable",
        message: BrowserAutomationErrorMessages.BrowserScriptApiUnavailable,
        cause: { name: "ReferenceError", message: expect.stringContaining(hint) },
      },
    });
  });

  it.each([
    [
      "locator.waitFor: Timeout 15000ms exceeded.\nCall log:\n  - waiting for locator('[data-timeline-row-kind=\"message\"]').first() to be visible\n  - locator resolved to <div>private-page-text</div>",
      {
        name: "TimeoutError",
        api: "locator.waitFor",
        message: "locator.waitFor: Timeout 15000ms exceeded.",
      },
    ],
    [
      "page.waitForFunction: Timeout 5000ms exceeded.",
      {
        name: "TimeoutError",
        api: "page.waitForFunction",
        message: "page.waitForFunction: Timeout 5000ms exceeded.",
      },
    ],
    [
      "page.evaluate: TypeError: Cannot read properties of null (reading 'textContent')\n    at eval (eval at evaluate (:303:30), <anonymous>:1:38)",
      {
        name: "TypeError",
        api: "page.evaluate",
        message: "page.evaluate: Cannot read properties of null (reading a property)",
      },
    ],
    [
      // A computed key can be page data: the engine message must not carry it.
      "page.evaluate: TypeError: Cannot read properties of null (reading 'hunter42')",
      {
        name: "TypeError",
        api: "page.evaluate",
        message: "page.evaluate: Cannot read properties of null (reading a property)",
      },
    ],
    [
      "page.evaluate: TypeError: privatePageFn is not a function",
      {
        name: "TypeError",
        api: "page.evaluate",
        message: "page.evaluate: a value is not a function",
      },
    ],
    [
      "page.evaluate: Error: private-page-text\n    at eval (eval at evaluate (:303:30), <anonymous>:1:15)",
      {
        name: "Error",
        api: "page.evaluate",
        message: expect.stringContaining("message was withheld because page code controls it"),
      },
    ],
    [
      "page.waitForFunction: private-page-text",
      { api: "page.waitForFunction", message: expect.stringContaining("withheld") },
    ],
    [
      "locator.click: Error: strict mode violation: getByRole('button') resolved to 2 elements:\n    1) <button>private-page-text</button>",
      {
        name: "Error",
        api: "locator.click",
        message:
          "locator.click: strict mode violation: the locator resolved to 2 elements. Use a more specific locator, .first() or .nth(i).",
      },
    ],
    [
      "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/private-path?token=private-token",
      {
        api: "page.goto",
        message: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/…",
      },
    ],
    [
      "Playwright code timed out after 15000ms",
      { name: "TimeoutError", message: expect.stringContaining("exceeded its 15000 ms budget") },
    ],
    ["Unexpected token ';'", { name: "SyntaxError", message: "Unexpected token ';'" }],
    [
      "Cannot read properties of undefined (reading 'foo')",
      { name: "TypeError", message: "Cannot read properties of undefined (reading a property)" },
    ],
    [
      "human.type needs about 33421 ms to type 350 characters at human pace, but about 18712 ms remain in this call. Nothing was typed. Use locator.fill(text) or page.keyboard.insertText(text) for long text, or raise timeoutMs.",
      { message: expect.stringContaining("page.keyboard.insertText(text)") },
    ],
  ])("returns a sanitized cause for %j", async (error, expected) => {
    mocks.run.mockResolvedValue({ ok: false, error, executionSettled: true });
    const failure = await run().catch((value: unknown) => value);
    expect(failure).toMatchObject({
      browserError: {
        code: "BrowserEvaluationFailed",
        message: BrowserAutomationErrorMessages.BrowserEvaluationFailed,
        cause: expected,
      },
    });
    expect(JSON.stringify(failure)).not.toContain("private");
    expect(mocks.connectionClose).toHaveBeenCalledWith(false);
  });

  it("bounds causes built from long first lines", async () => {
    mocks.run.mockResolvedValue({
      ok: false,
      error: `locator.fill: Error: ${"é".repeat(600)}`,
    });
    const failure = (await run().catch((value: unknown) => value)) as {
      browserError: { cause: { message: string } };
    };
    expect(Buffer.byteLength(failure.browserError.cause.message, "utf8")).toBeLessThanOrEqual(320);
  });

  it("points page.snapshot callers to the global snapshot helper", async () => {
    mocks.run.mockResolvedValue({ ok: false, error: "page.snapshot is not a function" });
    await expect(run()).rejects.toMatchObject({
      browserError: {
        code: "BrowserScriptApiUnavailable",
        message: expect.stringContaining("global snapshot()"),
      },
    });
  });

  it.each([
    "private-password is not defined",
    "getByRole is not defined: private-password",
    "private-password: document is not defined",
  ])("does not classify or expose unknown error text: %s", async (error) => {
    mocks.run.mockResolvedValue({ ok: false, error });
    const failure = await run().catch((value: unknown) => value);
    expect(failure).toMatchObject({ browserError: { code: "BrowserEvaluationFailed" } });
    expect(JSON.stringify(failure)).not.toContain("private-password");
    expect(JSON.stringify(failure)).not.toContain("sign in manually");
  });

  it("retains successful values and converts milliseconds to seconds", async () => {
    mocks.run.mockResolvedValue({ ok: true, result: { filled: true } });
    expect(await run()).toEqual({ filled: true });
    expect(mocks.run).toHaveBeenCalledWith("return null", {
      timeout: 30,
      signal: expect.any(AbortSignal),
      automaticUI: false,
    });
    expect(mocks.connectionClose).toHaveBeenCalledWith(false);
  });

  it("leases the tab through hostTarget, never the raw provider path", async () => {
    mocks.run.mockResolvedValue({ ok: true, result: null });
    await run();
    const options = mocks.constructedOptions.current as Record<string, unknown>;
    expect(options.hostTarget).toEqual(
      expect.objectContaining({
        connect: expect.any(Function),
        run: expect.any(Function),
        revokeAll: expect.any(Function),
      }),
    );
    expect(options).toMatchObject({ downloadPolicy: "deny", credentialCapture: false });
    expect(options).not.toHaveProperty("provider");
    expect(options).not.toHaveProperty("hostOwnedTarget");
  });

  it("preserves page work only after a trusted settled-failure receipt", async () => {
    mocks.run.mockResolvedValue({ ok: false, error: "fixture failure", executionSettled: true });
    await expect(run()).rejects.toMatchObject({
      browserError: { code: "BrowserEvaluationFailed" },
    });
    expect(mocks.connectionClose).toHaveBeenCalledWith(false);
  });

  it("cannot use a script-returned receipt to relax uncertain execution cleanup", async () => {
    mocks.run.mockResolvedValue({
      ok: false,
      error: "fixture failure",
      result: { executionSettled: true },
    });
    await expect(run()).rejects.toMatchObject({
      browserError: { code: "BrowserEvaluationFailed" },
    });
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
  });

  it("terminates uncertain execution when the worker transport rejects", async () => {
    mocks.run.mockRejectedValue(new Error("Worker disconnected"));
    await expect(run()).rejects.toThrow("Worker disconnected");
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
  });

  it("rejects and restores throttling when cancelled before the connection opens", async () => {
    const controller = new AbortController();
    mocks.openConnection.mockImplementation(() => new Promise(() => {}));
    const result = runBetterwright({
      home: "/synthetic",
      contents,
      code: "return null",
      timeoutMs: 30000,
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(false),
    );
    const reason = new Error("Cancelled before connect");
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it("revokes and terminates an active worker on cancellation", async () => {
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    mocks.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = runBetterwright({
      home: "/synthetic",
      contents,
      code: "return null",
      timeoutMs: 30000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    const reason = new Error("Human takeover");
    controller.abort(reason);
    expect(mocks.connectionClose).toHaveBeenCalledWith(true);
    finish({ ok: true, result: null });
    await expect(result).rejects.toBe(reason);
    expect(mocks.connectionClose).toHaveBeenCalledOnce();
  });
});
