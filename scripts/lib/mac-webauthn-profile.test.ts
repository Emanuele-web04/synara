import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { stageMacWebAuthnProfile } from "./mac-webauthn-profile.ts";

it.skipIf(process.platform !== "darwin")(
  "stages only the authorized channel's signed claims",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "synara-passkey-profile-"));
    const profile = join(dir, "fixture.provisionprofile");
    const entitlements = join(dir, "main.plist");
    const team = "FIXTURE123";
    const bundleId = "example.test.browser";
    const group = `${team}.${bundleId}.webauthn`;
    const claims = (groups: string) => `<plist version="1.0"><dict>
    <key>ProvisionsAllDevices</key><true/><key>ExpirationDate</key><date>2099-01-01T00:00:00Z</date>
    <key>Entitlements</key><dict>
    <key>com.apple.application-identifier</key><string>${team}.${bundleId}</string>
    <key>com.apple.developer.team-identifier</key><string>${team}</string>
    <key>keychain-access-groups</key><array><string>${groups}</string></array></dict></dict></plist>`;
    // A synthetic CMS data envelope exercises Apple's plist tools without a signing identity.
    const supply = (granted: string) =>
      execFileSync(
        "/usr/bin/openssl",
        ["cms", "-data_create", "-binary", "-outform", "DER", "-out", profile],
        { input: claims(granted) },
      );
    try {
      writeFileSync(
        entitlements,
        '<plist version="1.0"><dict><key>existing</key><true/></dict></plist>',
      );
      supply(`${team}.another-app`);
      expect(() => stageMacWebAuthnProfile({ profile, entitlements, team, bundleId })).toThrow(
        "does not authorize",
      );
      supply(`${team}.*`);
      expect(() =>
        stageMacWebAuthnProfile({ profile, entitlements, team, bundleId: `${bundleId}.beta` }),
      ).toThrow("for this team and app");
      expect(stageMacWebAuthnProfile({ profile, entitlements, team, bundleId })).toBe(group);
      const signedClaims = JSON.parse(
        execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", entitlements], {
          encoding: "utf8",
        }),
      );
      expect(signedClaims).toEqual({
        existing: true,
        "com.apple.application-identifier": `${team}.${bundleId}`,
        "com.apple.developer.team-identifier": team,
        "keychain-access-groups": [group],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
