import type { BrowserPasswordImportInput, BrowserPasswordImportResult } from "@synara/contracts";
import { execProcessFile } from "@synara/shared/processRuntime";
import { homedir } from "node:os";
import { BrowserVault } from "./browserVault";
import { listChromiumProfileInventory } from "./chromiumProfileInventory";
import { BrowserPasswordReadError, readChromiumProfilePasswords } from "./chromiumPasswordReader";

const MAX_PROFILE_LOGINS = 50_000;

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
type KeychainError = Error & { keychainFailure: KeychainFailure };

function keychainError(keychainFailure: KeychainFailure): KeychainError {
  return Object.assign(new Error("Browser Keychain access failed."), { keychainFailure });
}

function readMacKeychainSecret(browser: string): Promise<string> {
  const keychain = Object.hasOwn(KEYCHAIN_SOURCES, browser) ? KEYCHAIN_SOURCES[browser] : undefined;
  if (!keychain) return Promise.reject(keychainError("keychain_unavailable"));
  return new Promise((resolve, reject) => {
    execProcessFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-a", keychain.account, "-s", keychain.service],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 4_096, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) {
          const message = String(error.message);
          reject(
            keychainError(
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
          reject(keychainError("keychain_unavailable"));
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
  constructor(
    private readonly vault: BrowserVault,
    private readonly getKeychainSecret: (
      browser: string,
    ) => Promise<string> = readMacKeychainSecret,
    private readonly home = homedir(),
    private readonly getInventory = listChromiumProfileInventory,
  ) {}

  async import(input: BrowserPasswordImportInput): Promise<BrowserPasswordImportResult> {
    const currentPlatform = platform();
    if (input.confirmed !== true)
      return { ok: false, code: "reader_failed", platform: currentPlatform };
    if (currentPlatform !== "macos")
      return { ok: false, code: "unsupported_platform", platform: currentPlatform };

    const inventory = await this.getInventory(this.home);
    const browser = inventory.find(({ id }) => id === input.browser);
    const profile = browser?.profiles.find(({ id }) => id === input.profile);
    if (!browser || !profile)
      return { ok: false, code: "source_missing", platform: currentPlatform };
    if (profile.passwordCount === 0) return { ok: true, imported: 0, skipped: 0, warnings: [] };
    if (profile.passwordCount === null || profile.passwordStatus !== "available")
      return { ok: false, code: "reader_failed", platform: currentPlatform };
    if (profile.passwordCount > MAX_PROFILE_LOGINS)
      return { ok: false, code: "too_many_logins", platform: currentPlatform };
    try {
      if ((await this.vault.snapshot()).protection.locked)
        return { ok: false, code: "vault_locked", platform: currentPlatform };
    } catch {
      return { ok: false, code: "vault_failed", platform: currentPlatform };
    }

    let passphrase: string;
    try {
      passphrase = await this.getKeychainSecret(input.browser);
    } catch (error) {
      const failure = error as Partial<KeychainError>;
      const code = failure.keychainFailure ?? "keychain_unavailable";
      return { ok: false, code, platform: currentPlatform };
    }

    let read: Awaited<ReturnType<typeof readChromiumProfilePasswords>>;
    try {
      read = await readChromiumProfilePasswords(
        this.home,
        input.browser,
        input.profile,
        passphrase,
      );
    } catch (error) {
      const code = error instanceof BrowserPasswordReadError ? error.code : "reader_failed";
      return {
        ok: false,
        code: code === "source_missing" || code === "too_many_logins" ? code : "reader_failed",
        platform: currentPlatform,
      };
    } finally {
      passphrase = "";
    }

    try {
      const result = await this.vault.importPasswords(read.logins);
      read.logins.length = 0;
      return {
        ok: true,
        imported: result.imported,
        skipped: result.skipped + read.skipped,
        warnings: result.provenanceSaved ? [] : ["provenance_not_saved"],
      };
    } catch {
      read.logins.length = 0;
      return { ok: false, code: "vault_failed", platform: currentPlatform };
    }
  }
}
