import type { BrowserPasswordImportInput, BrowserPasswordImportResult } from "@synara/contracts";
import { execProcessFile } from "@synara/shared/processRuntime";
import { homedir } from "node:os";
import { BrowserVault } from "./browserVault";
import type { ChromiumInventorySourceId } from "./chromiumProfileInventory";
import type { BrowserPasswordLogin } from "./chromiumPasswordReader";
import {
  inventoryChromiumPasswordProfileProcess,
  readChromiumProfilePasswordsProcess,
} from "./chromiumPasswordReadProcess";

const MAX_PROFILE_LOGINS = 50_000;
type PasswordProfilePreflight =
  | Awaited<ReturnType<typeof inventoryChromiumPasswordProfileProcess>>
  | undefined;

const KEYCHAIN_SOURCES: Record<string, { account: string; service: string }> = {
  chrome: { account: "Chrome", service: "Chrome Safe Storage" },
  "chrome-beta": { account: "Chrome", service: "Chrome Safe Storage" },
  "chrome-dev": { account: "Chrome", service: "Chrome Safe Storage" },
  "chrome-canary": { account: "Chrome", service: "Chrome Safe Storage" },
  edge: { account: "Microsoft Edge", service: "Microsoft Edge Safe Storage" },
  brave: { account: "Brave", service: "Brave Safe Storage" },
  arc: { account: "Arc", service: "Arc Safe Storage" },
  dia: { account: "Dia", service: "Dia Safe Storage" },
  vivaldi: { account: "Vivaldi", service: "Vivaldi Safe Storage" },
  opera: { account: "Opera", service: "Opera Safe Storage" },
  "opera-gx": { account: "Opera", service: "Opera Safe Storage" },
  chromium: { account: "Chromium", service: "Chromium Safe Storage" },
  helium: { account: "Helium", service: "Helium Storage Key" },
  comet: { account: "Comet", service: "Comet Safe Storage" },
  aside: { account: "Aside", service: "Aside Safe Storage" },
};

type KeychainFailure = "permission_denied" | "timed_out" | "keychain_unavailable";
class KeychainError extends Error {
  constructor(readonly keychainFailure: KeychainFailure) {
    super("Browser Keychain access failed.");
  }
}

function readMacKeychainSecret(browser: string, signal?: AbortSignal): Promise<string> {
  const keychain = Object.hasOwn(KEYCHAIN_SOURCES, browser) ? KEYCHAIN_SOURCES[browser] : undefined;
  if (!keychain) return Promise.reject(new KeychainError("keychain_unavailable"));
  return new Promise((resolve, reject) => {
    execProcessFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-a", keychain.account, "-s", keychain.service],
      { signal, encoding: "utf8", timeout: 15_000, maxBuffer: 4_096, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) {
          const message = String(error.message);
          reject(
            new KeychainError(
              error.killed
                ? "timed_out"
                : /cancel+ed|interaction|auth|denied|errsec-25308/i.test(message)
                  ? "permission_denied"
                  : "keychain_unavailable",
            ),
          );
          return;
        }
        const value = stdout.replace(/\r?\n$/, "");
        if (!value) {
          reject(new KeychainError("keychain_unavailable"));
          return;
        }
        resolve(value);
      },
    );
  });
}

function platform(): "macos" | "windows" | "linux" {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

export class BrowserPasswordImport {
  private active: { operationId: string | undefined; controller: AbortController } | undefined;

  cancel(operationId: string): void {
    if (this.active?.operationId === operationId) this.active.controller.abort();
  }
  constructor(
    private readonly vault: BrowserVault,
    private readonly getKeychainSecret: (
      browser: string,
      signal?: AbortSignal,
    ) => Promise<string> = readMacKeychainSecret,
    private readonly home = homedir(),
    private readonly getProfile: (
      home: string,
      browser: ChromiumInventorySourceId,
      profile: string,
      signal: AbortSignal,
    ) => Promise<PasswordProfilePreflight> = inventoryChromiumPasswordProfileProcess,
    private readonly readPasswords: (
      home: string,
      browser: ChromiumInventorySourceId,
      profile: string,
      passphrase: string,
      signal: AbortSignal,
    ) => Promise<{
      logins: BrowserPasswordLogin[];
      skipped: number;
    }> = readChromiumProfilePasswordsProcess,
  ) {}

  async import(input: BrowserPasswordImportInput): Promise<BrowserPasswordImportResult> {
    if (this.active) return { ok: false, code: "vault_failed", platform: platform() };
    const active = { operationId: input.operationId, controller: new AbortController() };
    this.active = active;
    try {
      return await this.importProfile(input, active.controller.signal);
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  private async importProfile(
    input: BrowserPasswordImportInput,
    signal: AbortSignal,
  ): Promise<BrowserPasswordImportResult> {
    const currentPlatform = platform();
    const cancelled = (): BrowserPasswordImportResult => ({
      ok: false,
      code: "cancelled",
      platform: currentPlatform,
    });
    if (input.confirmed !== true)
      return { ok: false, code: "reader_failed", platform: currentPlatform };
    if (currentPlatform !== "macos")
      return { ok: false, code: "unsupported_platform", platform: currentPlatform };

    let profile: PasswordProfilePreflight;
    try {
      profile = await this.getProfile(this.home, input.browser, input.profile, signal);
    } catch (error) {
      if (signal.aborted) return cancelled();
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      return {
        ok: false,
        code:
          code === "EACCES" || code === "EPERM"
            ? "permission_denied"
            : code === "ENOENT"
              ? "source_missing"
              : "reader_failed",
        platform: currentPlatform,
      };
    }
    if (signal.aborted) return cancelled();
    if (!profile) return { ok: false, code: "source_missing", platform: currentPlatform };
    if (profile.count === 0) return { ok: true, imported: 0, skipped: 0, warnings: [] };
    if (profile.count === null || profile.status !== "available")
      return { ok: false, code: "reader_failed", platform: currentPlatform };
    if (profile.count > MAX_PROFILE_LOGINS)
      return { ok: false, code: "too_many_logins", platform: currentPlatform };
    try {
      if ((await this.vault.snapshot()).protection.locked)
        return { ok: false, code: "vault_locked", platform: currentPlatform };
    } catch {
      return { ok: false, code: "vault_failed", platform: currentPlatform };
    }

    let passphrase: string;
    try {
      passphrase = await this.getKeychainSecret(input.browser, signal);
      if (signal.aborted) {
        passphrase = "";
        return cancelled();
      }
    } catch (error) {
      if (signal.aborted) return cancelled();
      const code = error instanceof KeychainError ? error.keychainFailure : "keychain_unavailable";
      return { ok: false, code, platform: currentPlatform };
    }

    let read: { logins: BrowserPasswordLogin[]; skipped: number };
    try {
      read = await this.readPasswords(this.home, input.browser, input.profile, passphrase, signal);
    } catch (error) {
      if (signal.aborted) return cancelled();
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "reader_failed";
      return {
        ok: false,
        code:
          code === "source_missing" || code === "too_many_logins" || code === "source_too_large"
            ? code
            : "reader_failed",
        platform: currentPlatform,
      };
    } finally {
      passphrase = "";
    }

    try {
      if (signal.aborted) {
        read.logins.length = 0;
        return cancelled();
      }
      const result = await this.vault.importPasswords(read.logins);
      read.logins.length = 0;
      return {
        ok: true,
        imported: result.imported,
        skipped: result.skipped + read.skipped,
        warnings: [
          ...(result.provenanceSaved ? [] : ["provenance_not_saved"]),
          ...(result.auditSaved === false ? ["audit_not_saved"] : []),
        ],
      };
    } catch {
      read.logins.length = 0;
      return { ok: false, code: "vault_failed", platform: currentPlatform };
    }
  }
}
