# Browser cookie import

The welcome tour and Settings → General let you select detected browser profiles and import signed-in sessions. On macOS, saved passwords can also be imported into the unlocked Saved Logins vault. Nothing is imported until you confirm. Safari's optional Full Disk Access setup is separate; Chromium imports request Keychain access when needed.

In Synara's browser, open **Saved logins → Import browser cookies**. Choose a browser and profile, then import **this site**, or explicitly confirm **all sites in this profile**. Imported sessions are shared across Synara browser tabs and agent workflows. This imports cookies, not passwords, bookmarks, extensions, or history.

On macOS, the picker supports Chrome, Safari, Edge, **Helium, Aside, Arc, and Dia**. The new sources use their own profile directories and Keychain items:

| Browser | Profile root under `~/Library/Application Support` | Keychain service / account      |
| ------- | -------------------------------------------------- | ------------------------------- |
| Helium  | `net.imput.helium`                                 | `Helium Storage Key` / `Helium` |
| Aside   | `Aside`                                            | `Aside Safe Storage` / `Aside`  |
| Arc     | `Arc/User Data`                                    | `Arc Safe Storage` / `Arc`      |
| Dia     | `Dia/User Data`                                    | `Dia Safe Storage` / `Dia`      |

Arc reuses the existing native reader. Helium, Aside, and Dia share one macOS Chromium reader; profiles with cookie databases are discovered when selected. They support the `Cookies` and `Network/Cookies` layouts and `v10` encryption, including database version 24 host binding. Unknown encryption formats are skipped. Custom profile paths and symlinked cookie stores are refused. Custom source databases and private snapshots are bounded to 64 MiB and 100,000 rows. Profile discovery stops after 256 directory entries. Cookie stores must be ordinary tables; selected cells are bounded to 16 KiB and streamed source rows to 6 MiB before site filtering. The existing transfer limit remains 10,000 cookies / 6 MiB after site filtering.

On Linux, Chromium profile inventory recognizes standard Chrome, Edge, Brave, Vivaldi, Opera, Opera GX, and Chromium data roots, including common Flatpak and Snap locations. It reports profile/store availability from file metadata without opening databases or decrypting values. Database validation and row counting run only for the selected password profile after import confirmation. Sources with no profiles returned by the runtime reader are hidden. This inventory does not establish that a browser executable is still installed: old profile data can remain after uninstall. Linux saved-password import is not implemented, and encrypted cookies or profiles in nonstandard locations may remain unavailable.

Keychain access happens only after a human starts an import. Denying access fails the import; no other browser's key is tried. Navigation or tab destruction cancels the owner operation. Cookie transfer may succeed when the optional secure session-restoration checkpoint is unavailable; the result must report that limitation. Cookie values and native diagnostics are never returned to the UI or agent tools. No automatic import, password capture, or cross-channel Synara state copy is added.

If Linux has no OS-backed key store, Synara reports that imported session cookies could not be saved for secure restoration; it does not write an unprotected session snapshot. If a later import occurs after the key store becomes available, Synara retries wrapping the existing in-memory key and can persist the previously imported domains for that run.

If import fails, review the reported permissions or profile availability, or sign in directly. Windows and Linux continue to use the native cookie reader; their browser and profile coverage is not yet complete. Windows Chrome/Edge App-Bound v20 cookies cannot be read by the current import path. Recovery by injecting into a browser process is disabled.

Discovery reports data availability rather than querying row counts before confirmation.

Verification includes disposable SQLite fixtures, real Helium and Aside cookie databases with actual macOS Keychain reads, an isolated Electron run of the production import owner and secure session restoration, and Linux profile-inventory fixtures for Chrome, Edge Flatpak, Brave Snap, Chromium Snap, Opera, and Vivaldi. Live Arc and Dia imports, signed-app permission prompts, packaged Windows behavior, Linux password import, and broad platform/browser coverage remain unverified.

References: [Helium Keychain branding](https://github.com/imputnet/helium-macos/blob/main/patches/helium/macos/change-keychain-name.patch), [Browser roots and Keychain items](https://github.com/steipete/SweetCookieKit/blob/main/Sources/SweetCookieKit/BrowserCatalog.swift), [Chromium macOS encryption](https://github.com/chromium/chromium/blob/main/components/os_crypt/async/browser/keychain_key_provider.mm). Aside's Keychain branding was checked against its installed application binary without reading user data.

Saved-password import reads ordinary login tables containing supported macOS Chromium `v10` records as complete UTF-8 password text. Encrypted passwords are bounded to 16 KiB per row, origin/username text to 4 KiB each, eligible rows to 50,000, and the decrypted batch to 6 MiB. Oversized batches fail before vault mutation with a size-limit result. It skips unsupported encryption and invalid text rather than discarding arbitrary leading bytes. Chromium’s [macOS login database](https://github.com/chromium/chromium/blob/main/components/password_manager/core/browser/password_store/login_database_mac.cc) uses [EncryptString16/DecryptString16](https://github.com/chromium/chromium/blob/main/components/os_crypt/async/common/encryptor.cc), without the cookie store’s domain-hash prefix.
