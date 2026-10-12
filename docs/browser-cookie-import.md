# Browser cookie import

On first launch, Synara introduces cookie import for all seven macOS browsers. Safari's optional Full Disk Access setup is a separate step; Chromium imports request their own Keychain access when needed.

In Synara's browser, open **Saved logins → Import browser cookies**. Choose a browser and profile, then import **this site**, or explicitly confirm **all sites in this profile**. Imported sessions are shared across Synara browser tabs and agent workflows. This imports cookies, not passwords, bookmarks, extensions, or history.

On macOS, the picker supports Chrome, Safari, Edge, **Helium, Aside, Arc, and Dia**. The new sources use their own profile directories and Keychain items:

| Browser | Profile root under `~/Library/Application Support` | Keychain service / account      |
| ------- | -------------------------------------------------- | ------------------------------- |
| Helium  | `net.imput.helium`                                 | `Helium Storage Key` / `Helium` |
| Aside   | `Aside`                                            | `Aside Safe Storage` / `Aside`  |
| Arc     | `Arc/User Data`                                    | `Arc Safe Storage` / `Arc`      |
| Dia     | `Dia/User Data`                                    | `Dia Safe Storage` / `Dia`      |

Arc reuses the existing native reader. Helium, Aside, and Dia share one macOS Chromium reader; profiles with cookie databases are discovered when selected. They support the `Cookies` and `Network/Cookies` layouts and `v10` encryption, including database version 24 host binding. Unknown encryption formats are skipped. Custom profile paths and symlinked cookie stores are refused. Source databases and private snapshots are bounded to 64 MiB and 100,000 rows; the existing transfer limit remains 10,000 cookies / 6 MiB after site filtering.

On Linux, Chromium profile inventory recognizes standard Chrome, Edge, Brave, Vivaldi, Opera, Opera GX, and Chromium data roots, including common Flatpak and Snap locations. It counts cookie and saved-password rows without reading or decrypting their values. Sources with no profiles returned by the runtime reader are hidden. This inventory does not establish that a browser executable is still installed: old profile data can remain after uninstall. Linux saved-password import is not implemented, and encrypted cookies or profiles in nonstandard locations may remain unavailable.

Keychain access happens only after a human starts an import. Denying access fails the import; no other browser's key is tried. Navigation or tab destruction cancels the owner operation. Secure session persistence must finish before success is reported. Cookie values and native diagnostics are never returned to the UI or agent tools. No automatic import, password capture, or cross-channel Synara state copy is added.

If import fails, review the reported permissions or profile availability, or sign in directly. Windows and Linux continue to use the native cookie reader; their browser and profile coverage is not yet complete. Windows Chrome/Edge App-Bound v20 cookies cannot be read by the current import path. Recovery by injecting into a browser process is disabled.

Verification includes disposable SQLite fixtures, real Helium and Aside cookie databases with actual macOS Keychain reads, an isolated Electron run of the production import owner and secure session restoration, and Linux profile-inventory fixtures for Chrome, Edge Flatpak, Brave Snap, Chromium Snap, Opera, and Vivaldi. Live Arc and Dia imports, signed-app permission prompts, packaged Windows behavior, Linux password import, and broad platform/browser coverage remain unverified.

References: [Helium Keychain branding](https://github.com/imputnet/helium-macos/blob/main/patches/helium/macos/change-keychain-name.patch), [Browser roots and Keychain items](https://github.com/steipete/SweetCookieKit/blob/main/Sources/SweetCookieKit/BrowserCatalog.swift), [Chromium macOS encryption](https://github.com/chromium/chromium/blob/main/components/os_crypt/async/browser/keychain_key_provider.mm). Aside's Keychain branding was checked against its installed application binary without reading user data.
