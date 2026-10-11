# Browser cookie import

In Synara's browser, open **Saved logins → Import browser cookies**. Choose a browser and profile, then import **this site**, or explicitly confirm **all sites in this profile**. Imported sessions are shared across Synara browser tabs and agent workflows. This imports cookies, not passwords, bookmarks, extensions, or history.

On macOS, the picker supports Chrome, Safari, Edge, **Helium, Aside, Arc, and Dia**. The new sources use their own profile directories and Keychain items:

| Browser | Profile root under `~/Library/Application Support` | Keychain service / account      |
| ------- | -------------------------------------------------- | ------------------------------- |
| Helium  | `net.imput.helium`                                 | `Helium Storage Key` / `Helium` |
| Aside   | `Aside`                                            | `Aside Safe Storage` / `Aside`  |
| Arc     | `Arc/User Data`                                    | `Arc Safe Storage` / `Arc`      |
| Dia     | `Dia/User Data`                                    | `Dia Safe Storage` / `Dia`      |

Arc reuses the existing native reader. Helium, Aside, and Dia share one macOS Chromium reader; profiles with cookie databases are discovered when selected. They support the `Cookies` and `Network/Cookies` layouts and `v10` encryption, including database version 24 host binding. Unknown encryption formats are skipped. Custom profile paths and symlinked cookie stores are refused. Source databases and private snapshots are bounded to 64 MiB and 100,000 rows; the existing transfer limit remains 10,000 cookies / 6 MiB after site filtering.

Keychain access happens only after a human starts an import. Denying access fails the import; no other browser's key is tried. Navigation or tab destruction cancels the owner operation. Secure session persistence must finish before success is reported. Cookie values and native diagnostics are never returned to the UI or agent tools. No automatic import, password capture, or cross-channel Synara state copy is added.

If import fails, review the reported permissions or profile availability, or sign in directly. The three custom sources are macOS-only; other platforms continue to use the native reader.

Verification uses disposable SQLite profiles, encrypted synthetic cookies, and injected Keychain responses. It does not establish signed-app Keychain prompts or packaged Windows behavior.

References: [Helium Keychain branding](https://github.com/imputnet/helium-macos/blob/main/patches/helium/macos/change-keychain-name.patch), [Browser roots and Keychain items](https://github.com/steipete/SweetCookieKit/blob/main/Sources/SweetCookieKit/BrowserCatalog.swift), [Chromium macOS encryption](https://github.com/chromium/chromium/blob/main/components/os_crypt/async/browser/keychain_key_provider.mm). Aside's Keychain branding was checked against its installed application binary without reading user data.
