# Synara browser import — Round 4 implementation

## Slice

Add a bounded macOS Chromium password reader as the basis for the password-import path.

## Changes

- Added profile-folder resolution and a read-only Chromium `Login Data` reader for `v10` password rows.
- Read the row count and streamed records inside one SQLite read transaction so an open browser's WAL remains visible and the 50,000-row cap applies to one consistent snapshot.
- Derive the Chromium PBKDF2 key once per profile, normalize HTTP(S) origins, and retain the newest usable login per Cedar-compatible host and username identity.
- Count unusable and duplicate records as skipped. Never read blacklisted records.
- Updated `THIRD_PARTY_NOTICES.md` to cover the Cedar-derived decryption logic.

## Verification

- Focused `chromiumPasswordReader.test.ts`: 3 passed.
- Changed-file `oxfmt --check`: passed.
- Desktop typecheck: the reader type errors were fixed; the package check still fails because installed `undici` types are missing at `apps/desktop/src/httpRuntime.ts:6`.
- `git diff --check`: passed.

## Review result

The first critic requested deterministic duplicate handling and a consistent SQLite snapshot; those findings were fixed and rechecked. The final critic returned **REVISE** because this reader is not connected to production, Keychain acquisition, vault persistence, or a user-facing import flow. The reader has no runtime callers. Its verdict is saved in `synara-browser-import-round4-critic.md`.

## Remaining gap

This is a reader prototype, not a usable password-import feature. Implement trusted key acquisition and safe, no-overwrite vault insertion, then expose explicit profile import in the shared onboarding/Settings panel.
