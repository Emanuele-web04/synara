# Helium cookie import

Helium is available as a one-time cookie-import source on macOS when a profile with a cookie database is found under `~/Library/Application Support/net.imput.helium`.

Use the existing browser import UI. Choose a profile and the current site, or explicitly confirm whole-profile import. Import remains a human-only operation: it does not expose cookie values to agent tools, enable credential capture, or grant unattended access. Current destination binding, navigation cancellation, native-browser operation exclusion, and encrypted session persistence are unchanged.

The reader uses the Helium-specific Keychain item `Helium Storage Key` / `Helium`, never another browser's key. A denied prompt fails the import. Profile extraction uses a consistent SQLite snapshot in a private temporary directory, then the shared Betterwright normalization, domain filtering, partition metadata, size limits, and transfer checks. Diagnostics contain bounded codes/counts rather than cookie values, paths, or Keychain output.

Supported encryption is Chromium's macOS `v10` AES-128-CBC format. Database version 24 and later cookies must match their embedded SHA-256 host digest. Unknown encryption tags fail closed and are counted as undecryptable; the former speculative `v11` layout is not treated as verified support. Empty plaintext cookie values are preserved.

This branch retains main's Betterwright 2.7.3 and host-target transport. The older branch's browser runtime, vault, popup, input, and session-recovery implementations have already been superseded upstream and are not restored or downgraded.

## Verification

`bun run --cwd apps/desktop test src/browserAutomation/heliumCookieSource.test.ts src/browserAutomation/browserCookieImport.test.ts`

The Helium tests use synthetic encrypted values and temporary SQLite profiles, mock OS selection, and inject Keychain responses. They exercise acquisition, profile selection, filtering, partitioning, v24 host binding, malformed inputs, and error handling on Linux CI too. They do not constitute a live macOS Keychain or signed-app smoke test; that remains a manual release qualification step with an isolated profile.

## Format references

- [Helium Keychain branding](https://github.com/imputnet/helium-macos/blob/main/patches/helium/macos/change-keychain-name.patch)
- [Chromium macOS key provider and v10 key tag](https://github.com/chromium/chromium/blob/main/components/os_crypt/async/browser/keychain_key_provider.mm)
