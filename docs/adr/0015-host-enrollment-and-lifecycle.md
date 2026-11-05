# Host enrollment paths and the Desktop host lifecycle

Three enrollment paths, all ending in the same signed link challenge (ADR 0011/0012):

1. **Desktop sign-in (primary)**: the bundled local host auto-registers when the user signs in — zero ceremony; hosts mostly come to exist this way. In a multi-member org, first sign-in prompts before making the host discoverable (ADR 0002).
2. **Desktop SSH bootstrap**: Desktop provisions a remote machine and seeds the link during provisioning.
3. **Device-code flow (headless)**: CLI on a browserless box prints a short code + URL; the owner approves from any signed-in browser (OAuth device-authorization shape). Covers raw VPSes without Desktop involvement.

Sign-out unlinks the Desktop's host: public key removed from the directory, other devices' sessions to it killed; the app keeps working fully local. Only a registration belonging to the signed-in user can be recovered after session expiry. Changing owners discards the previous local host credentials and private key before enrollment; historical files with mismatched owners remain offline until repaired.

The API still refuses another member taking over an environment already registered in the same workspace. That member stays signed in for local use without inheriting the previous host. When enrollment is allowed, the new owner receives a fresh keypair; a late completion from the previous owner cannot restore its local registration.

Device removal (lost/stolen): the API refuses the device key and push-revokes its live sessions, and a surviving device rotates the Sync Key, re-encrypting Host Secrets so the removed device cannot decrypt future ciphertext.
