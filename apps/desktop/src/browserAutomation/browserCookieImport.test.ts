import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { BrowserCookieImportInput, ThreadId } from "@synara/contracts";
import { Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBrowserManager } from "../browserManager";

const mocks = vi.hoisted(() => ({
  sources: vi.fn(),
  profiles: vi.fn(),
  sync: vi.fn(),
  closeBrowser: vi.fn(),
  closeConnection: vi.fn(),
  connect: vi.fn(),
  inventory: vi.fn(),
  exec: vi.fn(),
  constructedOptions: { current: undefined as unknown },
}));
vi.mock("betterwright", () => ({
  listCookieSourceBrowsers: mocks.sources,
  listCookieSourceProfiles: mocks.profiles,
  NetworkPolicy: class {},
  BetterWright: class {
    conn: { close(): Promise<void> } | undefined;
    closing: Promise<void> | undefined;
    constructor(
      public options: {
        hostTarget: { connect(arg: unknown): Promise<{ close(): Promise<void> }> };
      },
    ) {
      mocks.constructedOptions.current = options;
    }
    syncCookies = async (syncOptions?: unknown) => {
      this.conn ??= await this.options.hostTarget.connect({
        proxyUrl: "socks5://127.0.0.1:1",
      });
      return mocks.sync(syncOptions);
    };
    close = () =>
      (this.closing ??= (async () => {
        await this.conn?.close();
        await mocks.closeBrowser();
      })());
  },
}));
vi.mock("./betterwrightConnection", () => ({ openBetterwrightConnection: mocks.connect }));
vi.mock("./chromiumProfileInventory", () => ({
  listChromiumProfileInventory: mocks.inventory,
}));
vi.mock("@synara/shared/processRuntime", async (original) => ({
  ...(await original<typeof import("@synara/shared/processRuntime")>()),
  execProcessFile: mocks.exec,
}));
import { BrowserCookieImport } from "./browserCookieImport";

const input = {
  threadId: ThreadId.makeUnsafe("thread-1"),
  tabId: "tab-1",
  scope: "site",
  origin: "https://example.test",
  browser: "chrome",
  profile: "Default",
} as const;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.sources.mockResolvedValue([
    { id: "chrome", name: "Chrome" },
    { id: "firefox", name: "Firefox" },
  ]);
  mocks.profiles.mockResolvedValue([{ id: "Default", name: "Default" }]);
  mocks.sync.mockResolvedValue({
    ok: true,
    synced: 2,
    skipped: 1,
    cookieImportDomains: ["example.test"],
    warnings: [{ code: "unsupported", count: 1 }],
    cookie: "must-not-be-returned",
  });
  mocks.closeBrowser.mockResolvedValue(undefined);
  mocks.closeConnection.mockResolvedValue(undefined);
  mocks.constructedOptions.current = undefined;
  mocks.inventory.mockResolvedValue([]);
  mocks.connect.mockImplementation(async () => {
    let closing: Promise<void> | undefined;
    return {
      provider: { cdpUrl: "ws://127.0.0.1:1234/browser" },
      get closed() {
        return closing !== undefined;
      },
      close: (cancel = true) => (closing ??= Promise.resolve(mocks.closeConnection(cancel))),
    };
  });
});

function fixture(rememberSessionImport = vi.fn(async (_domains: readonly string[]) => {})) {
  const contents = Object.assign(new EventEmitter(), {
    getURL: (): string => input.origin,
    isDestroyed: (): boolean => false,
    session: {
      cookies: { flushStore: vi.fn(async () => {}) },
      setProxy: vi.fn(async () => {}),
      closeAllConnections: vi.fn(async () => {}),
    },
  });
  const releaseHumanOperation = vi.fn();
  const disposeProfileRuntime = vi.fn();
  const waitForAgents = vi.fn(async () => {});
  const manager = {
    beginHumanBrowserOperation: vi.fn(() => releaseHumanOperation),
    createProfileCookieImportRuntime: vi.fn(async () => ({
      webContents: contents,
      dispose: disposeProfileRuntime,
    })),
    getCookieImportRuntime: vi.fn(async () => ({ webContents: contents })),
  };
  return {
    importer: new BrowserCookieImport(
      "/synthetic-home",
      manager as unknown as DesktopBrowserManager,
      waitForAgents,
      rememberSessionImport,
    ),
    contents,
    manager,
    disposeProfileRuntime,
    releaseHumanOperation,
    waitForAgents,
    rememberSessionImport,
  };
}

describe("human-only cookie import", () => {
  it("uses the OS user home for inventory instead of the browser-engine state directory", async () => {
    const { importer } = fixture();
    await importer.inventoryChromiumProfiles();
    expect(mocks.inventory).toHaveBeenCalledExactlyOnceWith(homedir());
    expect(mocks.inventory).not.toHaveBeenCalledWith("/synthetic-home");
  });

  it("imports only the selected visible site with app-bound injection disabled and returns counts", async () => {
    const { importer, contents } = fixture();
    expect(await importer.sources()).toEqual([{ id: "chrome", name: "Chrome" }]);
    expect(await importer.import(input)).toEqual({
      ok: true,
      imported: 2,
      skipped: 1,
      warnings: [{ code: "unsupported", count: 1 }],
    });
    expect(mocks.sync).toHaveBeenCalledWith({
      source: { browser: "chrome", profile: "Default" },
      domains: ["example.test"],
      windowsAppBound: "disabled",
      timeoutMs: 30_000,
    });
    const options = mocks.constructedOptions.current as Record<string, unknown>;
    expect(options.hostTarget).toEqual(expect.objectContaining({ connect: expect.any(Function) }));
    expect(options).toMatchObject({ downloadPolicy: "deny", credentialCapture: false });
    expect(options).not.toHaveProperty("provider");
    expect(options).not.toHaveProperty("hostOwnedTarget");
    expect(mocks.closeConnection).toHaveBeenCalledWith(false);
    expect(mocks.closeBrowser).toHaveBeenCalled();
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
  });

  it.each([
    ["helium", "Helium", "Helium Storage Key"],
    ["aside", "Aside", "Aside Safe Storage"],
    ["dia", "Dia", "Dia Safe Storage"],
  ])(
    "uses only %s's owned Keychain item and preserves import scope",
    async (browser, account, service) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
      try {
        mocks.exec.mockImplementation((_file, _args, _options, callback) =>
          callback(null, "synthetic-key\n"),
        );
        mocks.sync.mockImplementation(async () => {
          const options = mocks.constructedOptions.current as {
            chromiumKeychainPassword(browser: string, timeoutMs: number): Promise<string>;
          };
          expect(await options.chromiumKeychainPassword(browser, 30_000)).toBe("synthetic-key");
          await expect(
            options.chromiumKeychainPassword(browser === "helium" ? "aside" : "helium", 30_000),
          ).rejects.toThrow("Unsupported cookie source");
          await expect(options.chromiumKeychainPassword("__proto__", 30_000)).rejects.toThrow(
            "Unsupported cookie source",
          );
          return { ok: true, synced: 1, skipped: 0, cookieImportDomains: ["example.test"] };
        });
        const { importer } = fixture();
        expect(
          (
            await importer.import({
              ...input,
              browser: browser as "helium" | "aside" | "arc" | "dia",
            })
          ).ok,
        ).toBe(true);
        expect(mocks.exec).toHaveBeenCalledExactlyOnceWith(
          "/usr/bin/security",
          ["find-generic-password", "-w", "-a", account, "-s", service],
          expect.objectContaining({
            timeout: 15_000,
            maxBuffer: 4096,
            signal: expect.any(AbortSignal),
            killSignal: "SIGKILL",
          }),
          expect.any(Function),
        );
        expect(mocks.sync).toHaveBeenCalledWith(
          expect.objectContaining({ domains: ["example.test"], windowsAppBound: "disabled" }),
        );
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    },
  );

  it("cancels owned Keychain acquisition on navigation and exposes no helper output", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
    try {
      const { importer, contents, releaseHumanOperation } = fixture();
      mocks.exec.mockImplementation((_file, _args, options, callback) => {
        contents.emit("did-start-navigation", {}, "https://other.test", false, true);
        expect(options.signal.aborted).toBe(true);
        callback(new Error("synthetic-private-diagnostic"), "synthetic-private-key");
      });
      mocks.sync.mockImplementation(async () => {
        const options = mocks.constructedOptions.current as {
          chromiumKeychainPassword(browser: string, timeoutMs: number): Promise<string>;
        };
        await options.chromiumKeychainPassword("helium", 30_000);
        throw new Error("Import must not proceed after cancellation.");
      });
      const failure = await importer
        .import({ ...input, browser: "helium" })
        .catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toMatch(/synthetic-private/);
      expect(mocks.closeConnection).toHaveBeenCalledWith(true);
      expect(releaseHumanOperation).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("rejects other origins, profile paths and unsupported sources before extraction", async () => {
    const { importer } = fixture();
    await expect(importer.import({ ...input, origin: "https://unrelated.test" })).rejects.toThrow();
    await expect(
      importer.import({ ...input, profile: "/private/arbitrary-path" }),
    ).rejects.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrowserCookieImportInput)({ ...input, browser: "unsupported" }),
    ).toThrow();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("records an empty grant when the sync stores nothing", async () => {
    mocks.sync.mockResolvedValueOnce({
      ok: true,
      synced: 0,
      skipped: 0,
      cookieImportDomains: [],
      warnings: [],
    });
    const { importer, rememberSessionImport } = fixture();
    await expect(importer.import(input)).resolves.toMatchObject({ ok: true, imported: 0 });
    expect(rememberSessionImport).toHaveBeenCalledWith([]);
  });

  it("does not report success or release human control before durable cookie writes finish", async () => {
    const { importer, contents, releaseHumanOperation } = fixture();
    let flushed!: () => void;
    contents.session.cookies.flushStore.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          flushed = resolve;
        }),
    );
    let completed = false;
    const pending = importer.import(input).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(contents.session.cookies.flushStore).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect(releaseHumanOperation).not.toHaveBeenCalled();
    expect(mocks.closeBrowser).not.toHaveBeenCalled();
    flushed();
    expect((await pending).ok).toBe(true);
    expect(releaseHumanOperation).toHaveBeenCalledOnce();
  });

  it("does not report durable success when the cookie store cannot be flushed", async () => {
    const { importer, contents, releaseHumanOperation } = fixture();
    contents.session.cookies.flushStore.mockRejectedValue(new Error("synthetic-disk-failure"));
    await expect(importer.import(input)).rejects.toThrow("synthetic-disk-failure");
    expect(mocks.closeBrowser).toHaveBeenCalledOnce();
    expect(mocks.closeConnection).toHaveBeenCalledWith(false);
    expect(releaseHumanOperation).toHaveBeenCalledOnce();
  });

  it("requires session restoration checkpointing before reporting import success", async () => {
    const remember = vi.fn(async (_domains: readonly string[]) => {
      throw new Error("synthetic-checkpoint-failure");
    });
    const { importer, releaseHumanOperation } = fixture(remember);
    await expect(importer.import(input)).resolves.toMatchObject({
      ok: false,
      code: "persistence_failed",
      imported: 2,
      skipped: 1,
    });
    expect(remember).toHaveBeenCalledWith(["example.test"]);
    expect(releaseHumanOperation).toHaveBeenCalledOnce();
  });

  it("revokes the import connection on navigation and always cleans up after failure", async () => {
    const { importer, contents, releaseHumanOperation } = fixture();
    mocks.sync.mockImplementation(async () => {
      contents.emit("did-start-navigation", {}, "https://other.test", false, true);
      throw new Error("synthetic-read-failure");
    });
    await expect(importer.import(input)).rejects.toThrow();
    expect(mocks.closeConnection).toHaveBeenCalledTimes(1);
    expect(mocks.closeConnection).toHaveBeenCalledWith(true);
    expect(mocks.closeBrowser).toHaveBeenCalledTimes(1);
    expect(contents.listenerCount("destroyed")).toBe(0);
    expect(releaseHumanOperation).toHaveBeenCalledTimes(1);
  });

  it("does not report a successful sync that raced same-origin navigation", async () => {
    const { importer, contents } = fixture();
    const result = { ok: true, synced: 1, cookieImportDomains: ["example.test"] };
    mocks.sync.mockImplementation(async () => {
      contents.emit("did-start-navigation", {}, "https://example.test/next", false, true);
      return result;
    });
    await expect(importer.import(input)).rejects.toThrow();
    expect(contents.session.cookies.flushStore).not.toHaveBeenCalled();
    expect(mocks.closeConnection).toHaveBeenCalledWith(true);
  });

  it("does not report success when navigation interrupts durable cookie persistence", async () => {
    const { importer, contents } = fixture();
    contents.session.cookies.flushStore.mockImplementation(async () => {
      contents.emit("did-start-navigation", {}, "https://example.test/next", false, true);
    });
    await expect(importer.import(input)).rejects.toThrow();
    expect(mocks.closeConnection).toHaveBeenCalledWith(true);
  });

  it("holds human control until agents drain and import cleanup finishes", async () => {
    const { importer, manager, waitForAgents, releaseHumanOperation } = fixture();
    let drain!: () => void;
    waitForAgents.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          drain = resolve;
        }),
    );
    const pending = importer.import(input);
    await vi.waitFor(() => expect(waitForAgents).toHaveBeenCalledTimes(1));
    expect(manager.beginHumanBrowserOperation).toHaveBeenCalledTimes(1);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(releaseHumanOperation).not.toHaveBeenCalled();
    await expect(importer.import(input)).rejects.toThrow("Another cookie import");
    drain();
    await pending;
    expect(mocks.closeBrowser).toHaveBeenCalledTimes(1);
    expect(releaseHumanOperation).toHaveBeenCalledTimes(1);
    expect(releaseHumanOperation.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.closeBrowser.mock.invocationCallOrder[0]!,
    );
  });

  it("rechecks the destination after draining and releases the lease on failure", async () => {
    const { importer, contents, waitForAgents, releaseHumanOperation } = fixture();
    waitForAgents.mockImplementation(async () => {
      contents.getURL = () => "https://other.test";
    });
    await expect(importer.import(input)).rejects.toThrow("destination changed");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(releaseHumanOperation).toHaveBeenCalledTimes(1);
  });

  it("imports an explicitly confirmed whole profile through a hidden shared-session target", async () => {
    const { importer, manager, disposeProfileRuntime, rememberSessionImport } = fixture();
    const request = Schema.decodeUnknownSync(BrowserCookieImportInput)({
      browser: "chrome",
      profile: "Default",
      scope: "profile",
      confirmed: true,
    });
    expect(await importer.import(request)).toEqual({
      ok: true,
      imported: 2,
      skipped: 1,
      warnings: [{ code: "unsupported", count: 1 }],
    });
    expect(manager.createProfileCookieImportRuntime).toHaveBeenCalledTimes(1);
    expect(manager.createProfileCookieImportRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.profiles.mock.invocationCallOrder[0]!,
    );
    expect(manager.getCookieImportRuntime).not.toHaveBeenCalled();
    expect(disposeProfileRuntime).toHaveBeenCalledTimes(1);
    expect(rememberSessionImport).toHaveBeenCalledWith(["example.test"]);
  });

  it("disposes a profile target when setup fails before the reader starts", async () => {
    const { importer, waitForAgents, disposeProfileRuntime } = fixture();
    waitForAgents.mockRejectedValue(new Error("setup failed"));
    await expect(
      importer.import({
        browser: "chrome",
        profile: "Default",
        scope: "profile",
        confirmed: true,
      }),
    ).rejects.toThrow("setup failed");
    expect(disposeProfileRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects malformed targeted requests instead of treating them as destinationless", () => {
    const targeted = {
      threadId: input.threadId,
      browser: input.browser,
      profile: input.profile,
      scope: "profile",
      confirmed: true,
    };
    expect(() => Schema.decodeUnknownSync(BrowserCookieImportInput)(targeted)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrowserCookieImportInput)({
        ...targeted,
        tabId: input.tabId,
        threadId: "",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrowserCookieImportInput)({
        tabId: input.tabId,
        browser: input.browser,
        profile: input.profile,
        scope: "profile",
        confirmed: true,
      }),
    ).toThrow();
  });

  it("requires explicit profile consent and permits all-sites import from a blank tab", async () => {
    const { importer, contents, rememberSessionImport } = fixture();
    const profile = {
      threadId: input.threadId,
      tabId: input.tabId,
      browser: input.browser,
      profile: input.profile,
      scope: "profile",
    };
    for (const confirmed of [undefined, false, "true"])
      expect(() =>
        Schema.decodeUnknownSync(BrowserCookieImportInput)({ ...profile, confirmed }),
      ).toThrow();
    contents.getURL = () => "about:blank";
    const request = Schema.decodeUnknownSync(BrowserCookieImportInput)({
      ...profile,
      confirmed: true,
    });
    expect((await importer.import(request)).ok).toBe(true);
    expect(mocks.sync).toHaveBeenCalledWith({
      source: { browser: "chrome", profile: "Default" },
      windowsAppBound: "disabled",
      timeoutMs: 30_000,
    });
    expect(mocks.sync.mock.calls[0]![0]).not.toHaveProperty("domains");
    expect(rememberSessionImport).toHaveBeenCalledWith(["example.test"]);
  });

  it.each([
    [
      { cookieReaderCode: "source_extraction_failed", cookiePermissionDenied: true },
      "permission_denied",
    ],
    [{ cookieReaderCode: "source_extraction_failed" }, "reader_failed"],
    [{ cookieReaderCode: "timed_out" }, "timed_out"],
    [{ cookieReaderCode: "reader_unavailable" }, "reader_unavailable"],
    [{ cookieReaderCode: "no_selected_source" }, "source_missing"],
    [{}, "transfer_failed"],
  ])(
    "returns only a fixed error category, never native diagnostic content",
    async (diagnostic, code) => {
      const { importer, releaseHumanOperation } = fixture();
      mocks.sync.mockResolvedValue({
        ok: false,
        error: "synthetic-private-diagnostic",
        ...diagnostic,
      });
      const result = await importer.import(input);
      expect(result).toMatchObject({ ok: false, code });
      expect(JSON.stringify(result)).not.toContain("synthetic-private-diagnostic");
      expect(releaseHumanOperation).toHaveBeenCalledOnce();
    },
  );
});
