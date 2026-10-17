# Phone passkey helper

This native client implements WebAuthn sign-in with an existing phone passkey over caBLE v2 (QR + Bluetooth proximity + an encrypted WebSocket tunnel). It runs once per request, stores no credentials, and returns the assertion to the originating embedded page. It supports macOS and Linux; Windows retains Electron's native OS path.

## Build and checks

Rust and Cargo, a C compiler, Perl and `tar` are required. Linux also needs `pkg-config`, the D-Bus development headers, BlueZ and a Bluetooth Low Energy adapter. OpenSSL is built statically. macOS builds need Xcode's command-line tools; add the Rust targets `aarch64-apple-darwin` and `x86_64-apple-darwin` when cross-building or making a universal binary.

From the repository root:

```sh
node apps/desktop/scripts/build-passkey-helper.mjs --prepare-only
cargo test --locked --manifest-path apps/desktop/native/passkeys/Cargo.toml
node apps/desktop/scripts/build-passkey-helper.mjs
bun run --cwd apps/desktop smoke:browser-passkeys
```

The Electron smoke uses an isolated profile and a synthetic localhost page. It checks the guest bridge, origin prompt, real native QR generation and cancellation with process-exit evidence. It does not simulate successful phone authentication. A signed macOS build must additionally be tested with a real phone and relying party, including passwordless account selection, permission denial, cancellation and subsequent reuse.

## Boundaries

- Cross-process schemas live in `packages/contracts/src/browserPasskeys.ts`.
- The main process accepts only registered browser main frames, derives the origin from Electron, and rejects unrelated/public-suffix relying party IDs. A trusted-shell confirmation starts the helper and pauses browser automation until the helper stops.
- The helper receives one bounded JSON request on stdin. Stdout carries QR/waiting events and one assertion or generic error. Its environment excludes provider credentials. No authenticator PIN, passkey private key or assertion is exposed through the shell UI or saved to disk.
- Results are checked against the original challenge, origin, RP hash, allowed credential IDs, presence and required verification flags. Navigation, timeout and shutdown cancel the operation. A helper whose exit cannot be proven continues to block admission and browser automation.
- Only explicit top-level `navigator.credentials.get({publicKey: ...})` requests are bridged. Enrollment and conditional requests retain native behavior. Unsupported extensions produce no extension outputs; PRF and related-origin authentication are not advertised.
- A site such as GitHub may describe phone-only authentication as partial support when its local platform-authenticator check returns false. This is distinct from a failed phone assertion: the bridge advertises hybrid transport but does not pretend that a local platform authenticator exists.

## Dependency and packaging

`webauthn-authenticator-rs` is pinned to 0.5.5 and its source archive is checked against SHA-256 before preparation. `scripts/build-passkey-helper.mjs` applies a small patch preserving CTAP's user handle through serialization and rejecting ambiguous multiple-account results unless the phone selected the account. This pre-1.0 library is not FIDO certified; the helper exposes only assertion operations, with no PIN, reset or credential-management commands.

`Cargo.lock` fixes the dependency graph. Release builds re-prepare verified source, build the requested architecture and ad-hoc sign the macOS helper; the normal release signer replaces that signature. A per-flavor embedded Info.plist supplies a separate macOS identity and Bluetooth usage description. The app bundle also carries the Bluetooth description.

Dependency notices and MPL-covered source archives, including the patch, ship beside the helper. Removing the helper disables the bridge and restores native Electron behavior. No database migration, session export, custom tunnel server or virtual authenticator is involved.
