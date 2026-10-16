import {
  BetterWright,
  listCookieSourceBrowsers,
  listCookieSourceProfiles,
  NetworkPolicy,
} from "betterwright";
import {
  BrowserCookieSource,
  type BrowserCookieImportInput,
  type BrowserCookieImportResult,
} from "@synara/contracts";
import { Schema } from "effect";
import { homedir } from "node:os";
import { execProcessFile } from "@synara/shared/processRuntime";
import type { DesktopBrowserManager } from "../browserManager";
import { synaraHostTarget } from "./betterwrightHostTarget";
import { listChromiumProfileInventory } from "./chromiumProfileInventory";
import { readChromiumCookieSnapshotProcess } from "./chromiumCookieReadProcess";

const KEYCHAIN_SOURCES: Record<string, { account: string; service: string }> = {
  helium: { account: "Helium", service: "Helium Storage Key" },
  aside: { account: "Aside", service: "Aside Safe Storage" },
  dia: { account: "Dia", service: "Dia Safe Storage" },
};

function importPlatform(): Extract<BrowserCookieImportResult, { ok: false }>["platform"] {
  return process.platform === "darwin"
    ? "macos"
    : process.platform === "win32"
      ? "windows"
      : "linux";
}

function cookieImportFailure(result: {
  cookieReaderStage?: unknown;
  cookieReaderCode?: unknown;
  cookieSyncFailureCode?: unknown;
  cookiePermissionDenied?: unknown;
}): Extract<BrowserCookieImportResult, { ok: false }> {
  const stages = ["acquisition", "parse", "decrypt", "decode", "query", "discovery"] as const;
  const stage = stages.find((stage) => stage === result.cookieReaderStage);
  const transferCode = result.cookieSyncFailureCode;
  let code: Extract<BrowserCookieImportResult, { ok: false }>["code"];
  if (result.cookiePermissionDenied === true) code = "permission_denied";
  else if (
    result.cookieReaderCode === "source_too_large" ||
    result.cookieReaderCode === "resource_exhausted"
  )
    code = "source_too_large";
  else if (
    transferCode === "redaction_capacity" ||
    transferCode === "target_capacity" ||
    transferCode === "target_eviction" ||
    transferCode === "target_failed"
  ) {
    code = transferCode;
  } else if (result.cookieReaderCode === "timed_out") code = "timed_out";
  else if (
    ["no_selected_source", "no_discovered_source"].includes(
      typeof result.cookieReaderCode === "string" ? result.cookieReaderCode : "",
    )
  )
    code = "source_missing";
  else if (result.cookieReaderCode === "reader_unavailable") code = "reader_unavailable";
  else if (result.cookieReaderCode) code = "reader_failed";
  else code = "transfer_failed";
  return {
    ok: false,
    code,
    platform: importPlatform(),
    ...(stage ? { stage } : {}),
  };
}

function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Cookie import cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export class BrowserCookieImport {
  private busy = false;
  private activeInterrupt: AbortController | undefined;
  private activeStop: ((cancel?: boolean) => void) | undefined;
  private cancellationRequested = false;

  constructor(
    private readonly home: string,
    private readonly manager: DesktopBrowserManager,
    private readonly waitForAgents: () => Promise<void>,
    private readonly rememberSessionImport: (
      domains: readonly string[],
    ) => Promise<void> = async () => {},
  ) {}

  async sources() {
    const browsers = (await listCookieSourceBrowsers()).filter(({ id }) =>
      Schema.is(BrowserCookieSource)(id),
    );
    return browsers.map(({ id, name }) => ({ id, name }));
  }

  async profiles(browser: string) {
    if (!Schema.is(BrowserCookieSource)(browser)) throw new Error("Unsupported cookie source.");
    return (await listCookieSourceProfiles(browser)).map(({ id, name }) => ({ id, name }));
  }

  async inventoryChromiumProfiles() {
    return listChromiumProfileInventory(homedir());
  }

  async import(input: BrowserCookieImportInput): Promise<BrowserCookieImportResult> {
    if (this.busy) throw new Error("Another cookie import is running.");
    this.busy = true;
    this.cancellationRequested = false;
    const interrupt = new AbortController();
    this.activeInterrupt = interrupt;
    let releaseHumanOperation: (() => void) | undefined;
    let profileRuntime:
      | Awaited<ReturnType<DesktopBrowserManager["createProfileCookieImportRuntime"]>>
      | undefined;
    try {
      releaseHumanOperation = this.manager.beginHumanBrowserOperation();
      const destination = "threadId" in input ? input : undefined;
      profileRuntime = destination
        ? undefined
        : await waitForAbortable(
            this.manager.createProfileCookieImportRuntime(interrupt.signal),
            interrupt.signal,
          );
      interrupt.signal.throwIfAborted();
      const profiles = await waitForAbortable(this.profiles(input.browser), interrupt.signal);
      interrupt.signal.throwIfAborted();
      if (!profiles.some(({ id }) => id === input.profile))
        return {
          ok: false,
          code: "source_missing",
          platform: importPlatform(),
        };
      const runtime =
        profileRuntime ??
        (await waitForAbortable(
          this.manager.getCookieImportRuntime(destination as NonNullable<typeof destination>),
          interrupt.signal,
        ));
      interrupt.signal.throwIfAborted();
      const origin = input.scope === "site" ? new URL(input.origin) : null;
      if (input.scope === "profile" && input.confirmed !== true)
        throw new Error("Confirm whole-profile session access.");
      if (
        input.scope === "site" &&
        origin &&
        (!["https:", "http:"].includes(origin.protocol) ||
          origin.origin !== input.origin ||
          new URL(runtime.webContents.getURL()).origin !== input.origin)
      ) {
        throw new Error("Cookie import must match the visible site.");
      }
      const assertTarget = async () => {
        if (profileRuntime) {
          if (runtime.webContents.isDestroyed())
            throw new Error("The profile import target is unavailable.");
          return;
        }
        if (
          !destination ||
          (await this.manager.getCookieImportRuntime(destination)).webContents !==
            runtime.webContents ||
          (origin && new URL(runtime.webContents.getURL()).origin !== origin.origin)
        )
          throw new Error("The cookie import destination changed.");
      };
      await waitForAbortable(assertTarget(), interrupt.signal);
      await waitForAbortable(this.waitForAgents(), interrupt.signal);
      interrupt.signal.throwIfAborted();
      await waitForAbortable(assertTarget(), interrupt.signal);
      // Revoke transport and cancel host-owned Keychain acquisition together.
      // Upstream syncCookies itself has no AbortSignal.
      const hostTarget = synaraHostTarget(runtime.webContents, {
        cookieImport: true,
        signal: interrupt.signal,
      });
      let browser: BetterWright | undefined;
      let close: Promise<void> | undefined;
      const stop = (cancel = false) => {
        interrupt.abort();
        close ??= Promise.allSettled([hostTarget.revokeAll(cancel), browser?.close()]).then(
          (results) => {
            const failure = results.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
          },
        );
        void close.catch(() => {});
      };
      this.activeStop = stop;
      const navigation = (
        _event: unknown,
        _url: string,
        _inPlace: boolean,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame) stop(true);
      };
      runtime.webContents.on("did-start-navigation", navigation);
      const destroyed = () => stop(true);
      runtime.webContents.once("destroyed", destroyed);
      const timeout = setTimeout(() => stop(true), 60_000);
      try {
        await assertTarget();
        interrupt.signal.throwIfAborted();
        browser = new BetterWright({
          home: this.home,
          chromiumKeychainPassword: (source, timeoutMs) =>
            new Promise<string>((resolve, reject) => {
              interrupt.signal.throwIfAborted();
              if (process.platform !== "darwin") {
                reject(new Error("Browser Keychain acquisition requires macOS."));
                return;
              }
              const keychain = Object.hasOwn(KEYCHAIN_SOURCES, source)
                ? KEYCHAIN_SOURCES[source]
                : undefined;
              if (!keychain || source !== input.browser) {
                reject(new Error("Unsupported cookie source."));
                return;
              }
              execProcessFile(
                "/usr/bin/security",
                ["find-generic-password", "-w", "-a", keychain.account, "-s", keychain.service],
                {
                  encoding: "utf8",
                  timeout: Math.max(1_000, Math.min(timeoutMs, 15_000)),
                  maxBuffer: 4_096,
                  signal: interrupt.signal,
                  killSignal: "SIGKILL",
                },
                (error, stdout) => {
                  if (interrupt.signal.aborted) {
                    reject(interrupt.signal.reason);
                    return;
                  }
                  if (error) {
                    // Keychain output is private; only fixed categories cross the reader boundary.
                    const message = String(error.message);
                    reject(
                      Object.assign(new Error("Browser Keychain acquisition failed."), {
                        cookieReaderCode: error.killed ? "timed_out" : "source_extraction_failed",
                        cookieReaderStage: "decrypt",
                        cookiePermissionDenied: /\bcancel+ed\b|interaction|auth/i.test(message),
                      }),
                    );
                    return;
                  }
                  const password = stdout.replace(/\r?\n$/, "");
                  if (password) resolve(password);
                  else
                    reject(
                      Object.assign(new Error("Browser Keychain value is unavailable."), {
                        cookieReaderCode: "reader_failed",
                        cookieReaderStage: "decrypt",
                      }),
                    );
                },
              );
            }),
          chromiumCookieSnapshot: (source, timeoutMs, keychainPassword) =>
            readChromiumCookieSnapshotProcess(
              source,
              timeoutMs,
              keychainPassword,
              interrupt.signal,
              homedir(),
            ),
          hostTarget,
          downloadPolicy: "deny",
          credentialCapture: false,
          vault: false,
          headless: false,
          adBlock: false,
          parkBackgroundPages: false,
          policy: new NetworkPolicy({ allowLoopback: true }),
        });
        const result = await browser.syncCookies({
          source: { browser: input.browser, profile: input.profile },
          ...(origin ? { domains: [origin.hostname] } : {}),
          windowsAppBound: "disabled",
          timeoutMs: 30_000,
        });
        interrupt.signal.throwIfAborted();
        if (!result.ok) {
          return cookieImportFailure(result);
        }
        await assertTarget();
        interrupt.signal.throwIfAborted();
        await runtime.webContents.session.cookies.flushStore();
        let sessionRestore: "available" | "unavailable" = "available";
        try {
          if (!Array.isArray(result.cookieImportDomains))
            throw new Error("Import scope metadata is unavailable.");
          await this.rememberSessionImport(result.cookieImportDomains);
        } catch {
          // Cookie sync and the persistent partition flush already succeeded. The
          // session-only restoration checkpoint is an additional capability, so
          // report it as a warning instead of masking the verified transfer.
          sessionRestore = "unavailable";
        }
        interrupt.signal.throwIfAborted();
        return {
          ok: true,
          imported: result.synced,
          skipped: result.skipped,
          sessionRestore,
          browser: input.browser,
          platform: importPlatform(),
          warnings: (result.warnings ?? []).map(({ code, count }) => ({ code, count })),
        };
      } finally {
        clearTimeout(timeout);
        runtime.webContents.removeListener("did-start-navigation", navigation);
        runtime.webContents.removeListener("destroyed", destroyed);
        stop();
        await close;
        await browser?.close();
      }
    } catch (error) {
      if (!this.cancellationRequested) {
        if (
          typeof error === "object" &&
          error !== null &&
          ("cookieReaderCode" in error || "cookiePermissionDenied" in error)
        )
          return cookieImportFailure(error);
        throw error;
      }
      return {
        ok: false,
        code: "cancelled",
        platform: importPlatform(),
      };
    } finally {
      this.activeStop = undefined;
      this.activeInterrupt = undefined;
      this.cancellationRequested = false;
      try {
        profileRuntime?.dispose();
      } finally {
        try {
          releaseHumanOperation?.();
        } finally {
          this.busy = false;
        }
      }
    }
  }

  async cancel(): Promise<void> {
    if (!this.busy) return;
    this.cancellationRequested = true;
    this.activeStop?.(true);
    this.activeInterrupt?.abort(new Error("Cookie import cancelled."));
  }
}
