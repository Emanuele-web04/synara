import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApiConfigError, loadApiConfig, type WorkosApiConfig } from "./config";

/** The default (WorkOS) shape, narrowed so field assertions typecheck. */
function loadWorkosConfig(env: Record<string, string | undefined>): WorkosApiConfig {
  const config = loadApiConfig(env);
  if (config.identityProvider !== "workos") throw new Error("expected the workos provider");
  return config;
}

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  WORKOS_API_KEY: "sk_test_123",
  WORKOS_CLIENT_ID: "client_123",
  ACCOUNT_BASE_URL: "https://accounts.example.com",
  API_PUBLIC_URL: "https://accounts.example.com/api/v1",
  API_SIGNING_KEY: Buffer.alloc(32, 1).toString("base64url"),
  RELAY_SERVICE_TOKEN: "relay-secret",
};

describe("loadApiConfig", () => {
  it("opens remote beta access only through an explicit valid deployment setting", () => {
    expect(loadWorkosConfig(base).remoteBetaAccessEnabled).not.toBe(true);
    for (const value of ["true", "false"]) {
      expect(
        loadWorkosConfig({ ...base, REMOTE_BETA_ACCESS_ENABLED: value }).remoteBetaAccessEnabled ===
          true,
      ).toBe(value === "true");
    }
    for (const value of ["", "1", "yes", "TRUE"]) {
      expect(() => loadWorkosConfig({ ...base, REMOTE_BETA_ACCESS_ENABLED: value })).toThrow(
        /REMOTE_BETA_ACCESS_ENABLED/,
      );
    }
  });

  it("accepts only destination-bound, one-to-one identity migration pairs", () => {
    const mapping = {
      clientId: base.WORKOS_CLIENT_ID,
      users: { user_old: "user_new" },
      organizations: { org_old: "org_new" },
    };
    expect(
      loadWorkosConfig({ ...base, WORKOS_IDENTITY_MAP: JSON.stringify(mapping) }).workosIdentityMap,
    ).toEqual(mapping);
    for (const invalid of [
      "invalid JSON",
      JSON.stringify({ ...mapping, clientId: "client_wrong" }),
      JSON.stringify({ ...mapping, users: { user_a: "user_new", user_b: "user_new" } }),
      JSON.stringify({ ...mapping, users: { user_old: "user_old" } }),
      JSON.stringify({ ...mapping, users: { user_a: "user_b", user_b: "user_c" } }),
      JSON.stringify({ ...mapping, organizations: { org_old: "user_new" } }),
      JSON.stringify({ clientId: base.WORKOS_CLIENT_ID }),
    ])
      expect(() => loadApiConfig({ ...base, WORKOS_IDENTITY_MAP: invalid })).toThrow(
        /WORKOS_IDENTITY_MAP/,
      );
  });
  it("loads multiline and dashboard-escaped APNs keys, rejecting partial and wrong-environment configurations", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const metadata = {
      APNS_KEY_ID: "ABCD123456",
      APNS_TEAM_ID: "TESTTEAM12",
      APNS_BUNDLE_ID: "com.example.synara",
      APNS_ENVIRONMENT: "sandbox",
    };
    for (const key of [pem, pem.replace(/\n/g, "\\n")]) {
      expect(loadApiConfig({ ...base, ...metadata, APNS_PRIVATE_KEY: key }).apns).toMatchObject({
        privateKey: pem,
        environment: "sandbox",
      });
    }
    expect(
      loadApiConfig({ ...base, ...metadata, APNS_PRIVATE_KEY: pem, APNS_ENVIRONMENT: "both" }).apns
        ?.environment,
    ).toBe("both");
    expect(() => loadApiConfig({ ...base, ...metadata })).toThrow(/APNS_PRIVATE_KEY/);
    expect(() =>
      loadApiConfig({ ...base, ...metadata, APNS_PRIVATE_KEY: pem, APNS_ENVIRONMENT: "test" }),
    ).toThrow(/APNs/);
    const production = {
      APNS_PRODUCTION_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
      APNS_PRODUCTION_KEY_ID: "PROD123456",
    };
    expect(
      loadApiConfig({
        ...base,
        ...metadata,
        APNS_PRIVATE_KEY: pem,
        APNS_ENVIRONMENT: "both",
        ...production,
      }).apns?.productionCredentials,
    ).toEqual({ privateKey: pem, keyId: "PROD123456" });
    for (const invalid of [
      { APNS_PRODUCTION_PRIVATE_KEY: pem },
      { APNS_PRODUCTION_KEY_ID: "PROD123456" },
      { ...production, APNS_PRODUCTION_PRIVATE_KEY: "not a private key" },
      { ...production, APNS_PRODUCTION_KEY_ID: "invalid" },
    ])
      expect(() =>
        loadApiConfig({ ...base, ...metadata, APNS_PRIVATE_KEY: pem, ...invalid }),
      ).toThrow(/APNS_|APNs/);
  });
  it("throws listing every missing required var", () => {
    expect(() => loadApiConfig({})).toThrow(ApiConfigError);
    expect(() => loadApiConfig({})).toThrow(
      /DATABASE_URL.*WORKOS_API_KEY.*WORKOS_CLIENT_ID.*ACCOUNT_BASE_URL.*API_PUBLIC_URL/s,
    );
  });

  it("reads the required vars", () => {
    expect(loadApiConfig(base)).toMatchObject({
      databaseUrl: base.DATABASE_URL,
      workosApiKey: base.WORKOS_API_KEY,
      workosClientId: base.WORKOS_CLIENT_ID,
      baseUrl: base.ACCOUNT_BASE_URL,
      apiPublicUrl: base.API_PUBLIC_URL,
      apiSigningKey: base.API_SIGNING_KEY,
    });
  });

  it("requires signing but works without the retired relay service key", () => {
    const { API_SIGNING_KEY: _signing, ...withoutSigning } = base;
    expect(() => loadApiConfig(withoutSigning)).toThrow(/API_SIGNING_KEY/);
    const { RELAY_SERVICE_TOKEN: _relay, ...withoutRelay } = base;
    expect(loadApiConfig(withoutRelay)).toMatchObject({ apiSigningKey: base.API_SIGNING_KEY });
  });

  it("reads the previous signing key for rotation", () => {
    expect(
      loadApiConfig({
        ...base,
        API_SIGNING_KEY_PREVIOUS: Buffer.alloc(32, 2).toString("base64url"),
      }).apiSigningKeyPrevious,
    ).toBe(Buffer.alloc(32, 2).toString("base64url"));
  });

  it("generates an ephemeral signing key with a warning only for the dev provider", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadApiConfig({
        IDENTITY_PROVIDER: "dev",
        DATABASE_URL: base.DATABASE_URL,
        ACCOUNT_BASE_URL: "http://localhost:8788",
        API_PUBLIC_URL: "http://localhost:8788/api/v1",
      });
      expect(Buffer.from(config.apiSigningKey, "base64url")).toHaveLength(32);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("ephemeral signing key"));
    } finally {
      warning.mockRestore();
    }
  });

  it("defaults port to 8788 and parses PORT", () => {
    expect(loadApiConfig(base).port).toBe(8788);
    expect(loadApiConfig({ ...base, PORT: "9000" }).port).toBe(9000);
  });

  it("defaults the WorkOS API url", () => {
    expect(loadWorkosConfig(base).workosApiUrl).toBe("https://api.workos.com");
  });

  it("accepts an overridden API url", () => {
    const config = loadWorkosConfig({ ...base, WORKOS_API_URL: "http://127.0.0.1:4010" });
    expect(config.workosApiUrl).toBe("http://127.0.0.1:4010");
  });

  // Both are resolved from WorkOS's OIDC metadata at verification time, not
  // guessed here. A hand-derived issuer was wrong for every real token: WorkOS
  // scopes `iss` to the environment's client id, which is not WORKOS_CLIENT_ID.
  it("leaves the issuer and JWKS url unset so they are discovered", () => {
    const config = loadWorkosConfig(base);
    expect(config.workosIssuer).toBeUndefined();
    expect(config.workosJwksUrl).toBeUndefined();
  });

  it("accepts a full JWKS url override", () => {
    const config = loadWorkosConfig({
      ...base,
      WORKOS_JWKS_URL: "http://127.0.0.1:4011/keys.json",
    });
    expect(config.workosJwksUrl).toBe("http://127.0.0.1:4011/keys.json");
  });

  // A custom auth domain changes `iss` to that domain, so it must be settable
  // independently of what discovery reports.
  it("accepts an explicit issuer override for a custom auth domain", () => {
    const config = loadWorkosConfig({ ...base, WORKOS_ISSUER: "https://auth.example.com" });
    expect(config.workosIssuer).toBe("https://auth.example.com");
  });

  // The no-proxy default: a direct/Docker self-host must not trust a header
  // any caller can forge. Proxied deployments (Railway) opt in with 1.
  it("defaults trusted proxy hops to zero and honours an explicit value", () => {
    expect(loadApiConfig(base).trustedProxyHops).toBe(0);
    expect(loadApiConfig({ ...base, TRUSTED_PROXY_HOPS: "1" }).trustedProxyHops).toBe(1);
  });

  it("leaves the profile proxy secret unset by default and reads a configured one", () => {
    expect(loadApiConfig(base).profileProxySecret).toBeUndefined();
    expect(loadApiConfig({ ...base, PROFILE_PROXY_SECRET: "" }).profileProxySecret).toBeUndefined();
    expect(loadApiConfig({ ...base, PROFILE_PROXY_SECRET: "s3cret" }).profileProxySecret).toBe(
      "s3cret",
    );
  });

  it("ignores a trailing slash on the API url so derived paths stay single-slashed", () => {
    const config = loadWorkosConfig({ ...base, WORKOS_API_URL: "https://api.workos.com/" });
    expect(config.workosApiUrl).toBe("https://api.workos.com");
  });
});
