import type { AccountBillingEnvironment } from "@synara/contracts";
import { resolveTrustedProxyHops } from "./clientIp";
import { createPrivateKey, randomBytes } from "node:crypto";
import { parseWorkosIdentityMap, type WorkosIdentityMap } from "./identity/workosIdentityMap";

/**
 * Where uploaded profile avatars live: any S3-compatible object store
 * (Cloudflare R2, MinIO, AWS S3, …), addressed path-style through a single
 * endpoint. All five variables are optional as a set — when any is missing
 * the avatar upload routes answer 503 and everything else runs unaffected,
 * so a deployment without object storage is a smaller deployment, not a
 * broken one.
 */
export type AvatarStorageConfig = {
  /** S3 endpoint origin, e.g. https://<account>.r2.cloudflarestorage.com — no trailing slash. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public origin the bucket is served from (CDN/custom domain), no trailing slash. */
  publicBaseUrl: string;
  /**
   * SigV4 signing region, from S3_REGION. Defaults to "auto" — the spelling
   * R2 requires and MinIO accepts — but real AWS rejects it, so an AWS
   * deployment sets its bucket's region (e.g. us-east-1) here.
   */
  region: string;
};

export type ApnsConfig = {
  privateKey: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  environment: "sandbox" | "production" | "both";
  /** Environment-restricted Apple keys need a separate Production signer. */
  productionCredentials?: { privateKey: string; keyId: string };
};

// Validate each configured signer before startup; never include key material in errors.
function apnsPrivateKey(value: string, name: string): string {
  const privateKey = value.replace(/\\n/g, "\n");
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
      throw new Error();
  } catch {
    throw new ApiConfigError(`${name} must be a P-256 PEM private key`);
  }
  return privateKey;
}

export function loadApnsConfig(env: Env): ApnsConfig | undefined {
  const names = [
    "APNS_PRIVATE_KEY",
    "APNS_KEY_ID",
    "APNS_TEAM_ID",
    "APNS_BUNDLE_ID",
    "APNS_ENVIRONMENT",
  ] as const;
  const productionNames = ["APNS_PRODUCTION_PRIVATE_KEY", "APNS_PRODUCTION_KEY_ID"] as const;
  const hasProductionCredentials = productionNames.some((name) => env[name] !== undefined);
  if (!names.some((name) => env[name] !== undefined) && !hasProductionCredentials) return undefined;
  requireVars(env, names);
  if (hasProductionCredentials) requireVars(env, productionNames);
  if (
    !/^[A-Z0-9]{10}$/.test(env.APNS_KEY_ID!) ||
    !/^[A-Z0-9]{10}$/.test(env.APNS_TEAM_ID!) ||
    !/^[A-Za-z0-9.-]{1,200}$/.test(env.APNS_BUNDLE_ID!) ||
    !["sandbox", "production", "both"].includes(env.APNS_ENVIRONMENT!) ||
    (hasProductionCredentials && !/^[A-Z0-9]{10}$/.test(env.APNS_PRODUCTION_KEY_ID!))
  )
    throw new ApiConfigError("Invalid APNs metadata or environment");
  return {
    privateKey: apnsPrivateKey(env.APNS_PRIVATE_KEY!, "APNS_PRIVATE_KEY"),
    keyId: env.APNS_KEY_ID!,
    teamId: env.APNS_TEAM_ID!,
    bundleId: env.APNS_BUNDLE_ID!,
    environment: env.APNS_ENVIRONMENT as ApnsConfig["environment"],
    ...(hasProductionCredentials
      ? {
          productionCredentials: {
            privateKey: apnsPrivateKey(
              env.APNS_PRODUCTION_PRIVATE_KEY!,
              "APNS_PRODUCTION_PRIVATE_KEY",
            ),
            keyId: env.APNS_PRODUCTION_KEY_ID!,
          },
        }
      : {}),
  };
}

/** Billing remains off by default; live execution needs a separate explicit opt-in. */
export type PolarBillingConfig = {
  environment: AccountBillingEnvironment;
  productionPaymentsEnabled?: boolean;
  /** Exact operator-owned HTTPS return origins; required in production. */
  returnOrigins?: readonly string[];
  expectedCatalog?: {
    currency: string;
    monthlyAmountMinor: number;
    yearlyAmountMinor: number;
    taxBehavior: "exclusive";
  };
  accessToken: string;
  webhookSecret: string;
  organizationId: string;
  monthlyProductId: string;
  yearlyProductId: string;
  desktopBenefitId: string;
  checkoutSuccessUrl: string;
  portalReturnUrl: string;
};

function polarReturnOrigins(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new ApiConfigError("POLAR_RETURN_ORIGINS must contain exact HTTPS origins");
        }
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.port ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new ApiConfigError(
            "POLAR_RETURN_ORIGINS must contain exact HTTPS origins without credentials, non-default ports, paths, queries or fragments",
          );
        return url.origin;
      }),
    ),
  ];
}

function polarReturnUrl(
  value: string,
  name: string,
  config: Pick<PolarBillingConfig, "environment" | "returnOrigins">,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiConfigError(`${name} must be an absolute URL`);
  }
  const sandboxLoopback =
    config.environment === "sandbox" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !sandboxLoopback))
    throw new ApiConfigError(
      `${name} must be HTTPS or sandbox HTTP loopback without credentials or fragment`,
    );
  if (
    config.environment === "production" &&
    !polarReturnOrigins(config.returnOrigins ?? []).includes(url.origin)
  )
    throw new ApiConfigError(`${name} must use an exact origin from POLAR_RETURN_ORIGINS`);
  return url.href;
}

/** Rechecked by the provider factory so hand-built configs cannot activate live billing. */
export function assertPolarBillingConfig(config: PolarBillingConfig): void {
  if (config.environment !== "sandbox" && config.environment !== "production")
    throw new ApiConfigError("POLAR_ENVIRONMENT must be sandbox or production");
  if (config.environment === "production" && config.productionPaymentsEnabled !== true)
    throw new ApiConfigError(
      "Production Polar billing requires POLAR_PRODUCTION_PAYMENTS_ENABLED=true",
    );
  if (
    config.environment === "production" &&
    polarReturnOrigins(config.returnOrigins ?? []).length === 0
  )
    throw new ApiConfigError("Production Polar billing requires POLAR_RETURN_ORIGINS");
  const catalog = config.expectedCatalog;
  if (config.environment === "production" && !catalog)
    throw new ApiConfigError(
      "Production Polar billing requires the POLAR_EXPECTED_* catalog settings",
    );
  if (
    catalog &&
    (!/^[A-Z]{3}$/.test(catalog.currency) ||
      !Number.isSafeInteger(catalog.monthlyAmountMinor) ||
      catalog.monthlyAmountMinor <= 0 ||
      !Number.isSafeInteger(catalog.yearlyAmountMinor) ||
      catalog.yearlyAmountMinor <= 0 ||
      catalog.taxBehavior !== "exclusive")
  )
    throw new ApiConfigError("Invalid POLAR_EXPECTED_* catalog settings");
  polarReturnUrl(config.checkoutSuccessUrl, "POLAR_CHECKOUT_SUCCESS_URL", config);
  polarReturnUrl(config.portalReturnUrl, "POLAR_PORTAL_RETURN_URL", config);
}

export function loadPolarBillingConfig(env: Env): PolarBillingConfig | undefined {
  if (env.POLAR_BILLING_ENABLED === undefined || env.POLAR_BILLING_ENABLED === "false")
    return undefined;
  if (env.POLAR_BILLING_ENABLED !== "true")
    throw new ApiConfigError("POLAR_BILLING_ENABLED must be true or false");
  if (env.POLAR_ENVIRONMENT !== "sandbox" && env.POLAR_ENVIRONMENT !== "production")
    throw new ApiConfigError("POLAR_ENVIRONMENT must be sandbox or production");
  const liveEnabled = env.POLAR_PRODUCTION_PAYMENTS_ENABLED;
  if (liveEnabled !== undefined && liveEnabled !== "true" && liveEnabled !== "false")
    throw new ApiConfigError("POLAR_PRODUCTION_PAYMENTS_ENABLED must be true or false");
  if (env.POLAR_ENVIRONMENT === "production" && liveEnabled !== "true")
    throw new ApiConfigError(
      "Production Polar billing requires POLAR_PRODUCTION_PAYMENTS_ENABLED=true",
    );
  const names = [
    "POLAR_ACCESS_TOKEN",
    "POLAR_WEBHOOK_SECRET",
    "POLAR_ORGANIZATION_ID",
    "POLAR_MONTHLY_PRODUCT_ID",
    "POLAR_YEARLY_PRODUCT_ID",
    "POLAR_DESKTOP_BENEFIT_ID",
    "POLAR_CHECKOUT_SUCCESS_URL",
    "POLAR_PORTAL_RETURN_URL",
  ] as const;
  requireVars(env, names);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const name of [
    "POLAR_ORGANIZATION_ID",
    "POLAR_MONTHLY_PRODUCT_ID",
    "POLAR_YEARLY_PRODUCT_ID",
    "POLAR_DESKTOP_BENEFIT_ID",
  ] as const) {
    if (!uuid.test(env[name]!)) throw new ApiConfigError(`${name} must be a UUID`);
  }
  if (env.POLAR_MONTHLY_PRODUCT_ID === env.POLAR_YEARLY_PRODUCT_ID)
    throw new ApiConfigError("Polar monthly and yearly products must differ");
  const catalogNames = [
    "POLAR_EXPECTED_CURRENCY",
    "POLAR_EXPECTED_MONTHLY_AMOUNT_MINOR",
    "POLAR_EXPECTED_YEARLY_AMOUNT_MINOR",
    "POLAR_EXPECTED_TAX_BEHAVIOR",
  ] as const;
  const hasCatalog = catalogNames.some((name) => env[name] !== undefined);
  if (hasCatalog || env.POLAR_ENVIRONMENT === "production") requireVars(env, catalogNames);
  const amountMinor = (
    name: "POLAR_EXPECTED_MONTHLY_AMOUNT_MINOR" | "POLAR_EXPECTED_YEARLY_AMOUNT_MINOR",
  ) => {
    const value = env[name]!;
    const amount = Number(value);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(amount))
      throw new ApiConfigError(`${name} must be a positive integer in minor currency units`);
    return amount;
  };
  const config: PolarBillingConfig = {
    environment: env.POLAR_ENVIRONMENT,
    ...(liveEnabled === "true" ? { productionPaymentsEnabled: true } : {}),
    ...(env.POLAR_RETURN_ORIGINS !== undefined
      ? {
          returnOrigins: polarReturnOrigins(
            env.POLAR_RETURN_ORIGINS.split(",")
              .map((origin) => origin.trim())
              .filter(Boolean),
          ),
        }
      : {}),
    ...(hasCatalog
      ? {
          expectedCatalog: {
            currency: env.POLAR_EXPECTED_CURRENCY!,
            monthlyAmountMinor: amountMinor("POLAR_EXPECTED_MONTHLY_AMOUNT_MINOR"),
            yearlyAmountMinor: amountMinor("POLAR_EXPECTED_YEARLY_AMOUNT_MINOR"),
            taxBehavior: env.POLAR_EXPECTED_TAX_BEHAVIOR as "exclusive",
          },
        }
      : {}),
    accessToken: env.POLAR_ACCESS_TOKEN!,
    webhookSecret: env.POLAR_WEBHOOK_SECRET!,
    organizationId: env.POLAR_ORGANIZATION_ID!,
    monthlyProductId: env.POLAR_MONTHLY_PRODUCT_ID!,
    yearlyProductId: env.POLAR_YEARLY_PRODUCT_ID!,
    desktopBenefitId: env.POLAR_DESKTOP_BENEFIT_ID!,
    checkoutSuccessUrl: env.POLAR_CHECKOUT_SUCCESS_URL!,
    portalReturnUrl: env.POLAR_PORTAL_RETURN_URL!,
  };
  assertPolarBillingConfig(config);
  return {
    ...config,
    checkoutSuccessUrl: polarReturnUrl(
      config.checkoutSuccessUrl,
      "POLAR_CHECKOUT_SUCCESS_URL",
      config,
    ),
    portalReturnUrl: polarReturnUrl(config.portalReturnUrl, "POLAR_PORTAL_RETURN_URL", config),
  };
}

export type ApiConfigBase = {
  polarBilling?: PolarBillingConfig;
  /** Paid Remote access is opt-in and takes precedence over open-beta enrollment. */
  remoteBillingEnforced?: boolean;
  apns?: ApnsConfig;
  cloudflareTunnel?: CloudflareTunnelConfig;
  /** Explicit test enrollment only; this is not a paid-subscription entitlement. */
  remoteTestUserIds?: readonly string[];
  /** Open beta enrollment; authentication and host/device authorization still apply. */
  remoteBetaAccessEnabled?: boolean;
  databaseUrl: string;
  baseUrl: string;
  /** Exact JWT issuer and public origin for API-facing host auth. */
  apiPublicUrl: string;
  /** Base64url 32-byte Ed25519 seed used for API-signed grants. */
  apiSigningKey: string;
  /** Previous seed served through JWKS during rotation, verification-only. */
  apiSigningKeyPrevious?: string;
  port: number;
  /**
   * S3-compatible avatar storage, or undefined when the deployment has none
   * configured (uploads answer 503; everything else works).
   */
  avatarStorage?: AvatarStorageConfig;
  /**
   * How many proxies in front of this service append to `x-forwarded-for`,
   * from TRUSTED_PROXY_HOPS. The rate limiter keys on the address the
   * outermost trusted proxy saw; 0 means "no proxy — trust only the socket".
   * Defaults to 0, the direct/Docker self-host shape — any nonzero default
   * would let a direct caller forge the header and rotate rate-limit
   * buckets. Proxied deployments (Railway: one TLS-terminating hop) must
   * set TRUSTED_PROXY_HOPS=1 explicitly.
   */
  trustedProxyHops: number;
  /**
   * Shared secret the profiles SSR deployment sends as
   * `x-synara-proxy-secret`, from PROFILE_PROXY_SECRET. When set and matched,
   * the public-profile rate limit keys on the forwarded viewer IP instead of
   * the SSR deployment's egress IP. Undefined disables the channel — the
   * viewer header is ignored entirely.
   */
  profileProxySecret?: string;
};

/**
 * Configuration for the hosted identity provider (WorkOS). The only place
 * outside `src/identity/workos.ts` where WorkOS is named: config plumbing has
 * to spell the env vars, the implementation consumes them, and nothing else
 * in the service knows which provider is behind the seam.
 */
export type WorkosApiConfig = ApiConfigBase & {
  identityProvider: "workos";
  workosApiKey: string;
  workosClientId: string;
  /** Operator-approved old-to-current IDs; keeps existing Synara data ownership stable. */
  workosIdentityMap?: WorkosIdentityMap;
  /** WorkOS API origin, no trailing slash. Overridable so tests can point at a local server. */
  workosApiUrl: string;
  /**
   * Full JWKS URL, from WORKOS_JWKS_URL. Undefined means "discover it": the
   * OIDC metadata document is the single source of truth, and hand-deriving a
   * second one here is how the two drift apart.
   */
  workosJwksUrl?: string;
  /**
   * Expected `iss` claim on access tokens, from WORKOS_ISSUER. Undefined means
   * "discover it". There is no safe static default — WorkOS mints `iss` as
   * `{apiUrl}/user_management/{environment client id}`, and that environment
   * client id is not WORKOS_CLIENT_ID whenever the app is a non-default
   * AuthKit application. Set this only for a custom auth domain or a stand-in.
   */
  workosIssuer?: string;
  /**
   * Per-attempt deadline on cheap/idempotent WorkOS calls, milliseconds.
   * Test hook only — there is no env var for it; production uses the module
   * default (15s).
   */
  workosRequestTimeoutMs?: number;
  /**
   * Per-attempt deadline on grant-consuming WorkOS calls (authenticates,
   * token exchanges, refresh), milliseconds. Test hook only — production
   * uses the module default (45s): a grant spends a single-use credential,
   * so it gets far longer than a cheap lookup before we abandon it.
   */
  workosGrantTimeoutMs?: number;
};

/**
 * Configuration for the offline dev identity provider: an in-process identity
 * endpoint with codes printed to stdout, for hacking on Synara accounts with
 * no hosted-provider tenancy. Selected with IDENTITY_PROVIDER=dev and refused
 * outright in anything that looks like a deployment — see
 * {@link assertDevIdentityAllowed}.
 */
export type DevApiConfig = ApiConfigBase & {
  identityProvider: "dev";
};

export type ApiConfig = WorkosApiConfig | DevApiConfig;

export class ApiConfigError extends Error {}

type Env = Record<string, string | undefined>;

export type CloudflareTunnelConfig = {
  accountId: string;
  zoneId: string;
  apiToken: string;
  domain: string;
};

/** Administrative credentials stay in the account service, never the host config. */
export function loadCloudflareTunnelConfig(env: Env): CloudflareTunnelConfig | undefined {
  const names = [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_ZONE_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_TUNNEL_DOMAIN",
  ] as const;
  if (!names.some((name) => env[name] !== undefined)) return undefined;
  requireVars(env, names);
  const domain = env.CLOUDFLARE_TUNNEL_DOMAIN!.trim().toLowerCase();
  if (domain.length > 190 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))
    throw new ApiConfigError("CLOUDFLARE_TUNNEL_DOMAIN must be a DNS zone name");
  if (
    ![env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_ZONE_ID].every((value) =>
      /^[a-f0-9]{32}$/i.test(value!),
    )
  )
    throw new ApiConfigError("Cloudflare account and zone IDs must be 32 hexadecimal characters");
  if (!env.CLOUDFLARE_API_TOKEN!.trim())
    throw new ApiConfigError("CLOUDFLARE_API_TOKEN must not be empty");
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    zoneId: env.CLOUDFLARE_ZONE_ID!,
    apiToken: env.CLOUDFLARE_API_TOKEN!.trim(),
    domain,
  };
}

const REQUIRED_VARS = [
  "DATABASE_URL",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "ACCOUNT_BASE_URL",
  "API_PUBLIC_URL",
  "API_SIGNING_KEY",
] as const;

/** The dev provider stores rows and serves clients, so these it still needs. */
const REQUIRED_DEV_VARS = ["DATABASE_URL", "ACCOUNT_BASE_URL", "API_PUBLIC_URL"] as const;

const DEFAULT_WORKOS_API_URL = "https://api.workos.com";

/**
 * The hard safety gate on the dev identity provider. It accepts any email,
 * prints one-time codes to stdout, and must therefore be impossible to enable
 * accidentally in a deployed environment — so it refuses to start (the thrown
 * ApiConfigError exits the process from `main`) when the environment says
 * production, or when a WorkOS API key is present: a machine holding a real
 * identity-provider secret is configured to serve real users, and "dev" there
 * is a misconfiguration, not a choice.
 *
 * Called from {@link loadApiConfig} AND from the dev provider's own factory,
 * so hand-built configs cannot bypass it.
 */
export function assertDevIdentityAllowed(env: Env): void {
  if (env.NODE_ENV === "production") {
    throw new ApiConfigError(
      "IDENTITY_PROVIDER=dev refuses to start with NODE_ENV=production. " +
        "The dev identity provider accepts any email and prints sign-in codes " +
        "to stdout; it is for local development only. Unset IDENTITY_PROVIDER " +
        "to use the real identity provider.",
    );
  }
  if (env.WORKOS_API_KEY) {
    throw new ApiConfigError(
      "IDENTITY_PROVIDER=dev refuses to start while WORKOS_API_KEY is set. " +
        "A real identity-provider secret means this environment serves real " +
        "users; unset IDENTITY_PROVIDER to use it, or unset WORKOS_API_KEY " +
        "for offline development.",
    );
  }
}

function requireVars(env: Env, names: readonly string[]): void {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new ApiConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function signingSeed(
  env: Env,
  name: "API_SIGNING_KEY" | "API_SIGNING_KEY_PREVIOUS",
): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(value) || Buffer.from(value, "base64url").length !== 32) {
    throw new ApiConfigError(`${name} must be a base64url-encoded 32-byte Ed25519 seed`);
  }
  return value;
}

/** The five S3_* variables, valid only as a complete set. */
const AVATAR_STORAGE_VARS = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_PUBLIC_BASE_URL",
] as const;

/**
 * The avatar-storage config, or undefined when none of the S3_* variables are
 * set. A PARTIAL set is refused loudly rather than treated as absent: an
 * operator who set four of five variables was configuring storage, and a
 * silent 503 in production would hide the typo indefinitely.
 */
export function loadAvatarStorageConfig(env: Env): AvatarStorageConfig | undefined {
  const present = AVATAR_STORAGE_VARS.filter((name) => env[name]);
  if (present.length === 0) return undefined;
  if (present.length < AVATAR_STORAGE_VARS.length) {
    const missing = AVATAR_STORAGE_VARS.filter((name) => !env[name]);
    throw new ApiConfigError(
      `Avatar storage is partially configured — missing: ${missing.join(", ")}. ` +
        "Set all of S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, " +
        "and S3_PUBLIC_BASE_URL, or unset them all to run without avatar uploads.",
    );
  }
  return {
    endpoint: (env.S3_ENDPOINT as string).replace(/\/+$/, ""),
    bucket: env.S3_BUCKET as string,
    accessKeyId: env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
    publicBaseUrl: (env.S3_PUBLIC_BASE_URL as string).replace(/\/+$/, ""),
    // Optional, outside the all-or-nothing set: absent means R2's "auto".
    region: env.S3_REGION?.trim() || "auto",
  };
}

export function loadApiConfig(env: Env): ApiConfig {
  const identityProvider = env.IDENTITY_PROVIDER ?? "workos";
  if (identityProvider !== "workos" && identityProvider !== "dev") {
    throw new ApiConfigError(
      `Unknown IDENTITY_PROVIDER "${identityProvider}" — expected "workos" or "dev"`,
    );
  }

  const port = env.PORT ? Number.parseInt(env.PORT, 10) : 8788;
  const trustedProxyHops = resolveTrustedProxyHops(env.TRUSTED_PROXY_HOPS);
  const profileProxySecret = env.PROFILE_PROXY_SECRET?.trim() || undefined;
  const avatarStorage = loadAvatarStorageConfig(env);
  const polarBilling = loadPolarBillingConfig(env);
  const remoteBilling = env.POLAR_REMOTE_ACCESS_ENFORCED;
  if (remoteBilling !== undefined && remoteBilling !== "true" && remoteBilling !== "false")
    throw new ApiConfigError("POLAR_REMOTE_ACCESS_ENFORCED must be true or false");
  const remoteBillingEnforced = remoteBilling === "true";
  if (remoteBillingEnforced && !polarBilling)
    throw new ApiConfigError("POLAR_REMOTE_ACCESS_ENFORCED requires configured Polar billing");
  const apns = loadApnsConfig(env);
  const cloudflareTunnel = loadCloudflareTunnelConfig(env);
  const remoteTestUserIds = env.REMOTE_TEST_USER_IDS?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const betaAccess = env.REMOTE_BETA_ACCESS_ENABLED;
  if (betaAccess !== undefined && betaAccess !== "true" && betaAccess !== "false") {
    throw new ApiConfigError("REMOTE_BETA_ACCESS_ENABLED must be true or false");
  }
  const remoteBetaAccessEnabled = betaAccess === "true";

  if (identityProvider === "dev") {
    assertDevIdentityAllowed(env);
    requireVars(env, REQUIRED_DEV_VARS);
    const configuredSigningKey = signingSeed(env, "API_SIGNING_KEY");
    const apiSigningKeyPrevious = signingSeed(env, "API_SIGNING_KEY_PREVIOUS");
    const apiSigningKey =
      configuredSigningKey ?? Buffer.from(randomBytes(32)).toString("base64url");
    if (!configuredSigningKey) {
      console.warn("[api] API_SIGNING_KEY is unset in dev mode; using an ephemeral signing key");
    }
    return {
      identityProvider,
      ...(cloudflareTunnel ? { cloudflareTunnel } : {}),
      ...(remoteTestUserIds ? { remoteTestUserIds } : {}),
      remoteBetaAccessEnabled,
      remoteBillingEnforced,
      databaseUrl: env.DATABASE_URL as string,
      baseUrl: env.ACCOUNT_BASE_URL as string,
      apiPublicUrl: (env.API_PUBLIC_URL as string).replace(/\/+$/, ""),
      apiSigningKey,
      ...(apiSigningKeyPrevious ? { apiSigningKeyPrevious } : {}),
      port,
      trustedProxyHops,
      ...(profileProxySecret ? { profileProxySecret } : {}),
      ...(avatarStorage ? { avatarStorage } : {}),
      ...(polarBilling ? { polarBilling } : {}),
      ...(apns ? { apns } : {}),
    };
  }

  requireVars(env, REQUIRED_VARS);
  const workosClientId = env.WORKOS_CLIENT_ID as string;
  const workosIdentityMap = env.WORKOS_IDENTITY_MAP
    ? parseWorkosIdentityMap(env.WORKOS_IDENTITY_MAP, workosClientId)
    : undefined;
  const apiSigningKey = signingSeed(env, "API_SIGNING_KEY");
  if (!apiSigningKey) {
    throw new ApiConfigError("API_SIGNING_KEY must be a base64url-encoded 32-byte Ed25519 seed");
  }
  const apiSigningKeyPrevious = signingSeed(env, "API_SIGNING_KEY_PREVIOUS");
  const workosApiUrl = (env.WORKOS_API_URL ?? DEFAULT_WORKOS_API_URL).replace(/\/+$/, "");
  return {
    identityProvider,
    ...(cloudflareTunnel ? { cloudflareTunnel } : {}),
    ...(remoteTestUserIds ? { remoteTestUserIds } : {}),
    remoteBetaAccessEnabled,
    remoteBillingEnforced,
    databaseUrl: env.DATABASE_URL as string,
    baseUrl: env.ACCOUNT_BASE_URL as string,
    apiPublicUrl: (env.API_PUBLIC_URL as string).replace(/\/+$/, ""),
    apiSigningKey,
    ...(apiSigningKeyPrevious ? { apiSigningKeyPrevious } : {}),
    port,
    trustedProxyHops,
    ...(profileProxySecret ? { profileProxySecret } : {}),
    ...(avatarStorage ? { avatarStorage } : {}),
    ...(polarBilling ? { polarBilling } : {}),
    ...(apns ? { apns } : {}),
    workosApiKey: env.WORKOS_API_KEY as string,
    workosClientId,
    ...(workosIdentityMap ? { workosIdentityMap } : {}),
    workosApiUrl,
    ...(env.WORKOS_JWKS_URL ? { workosJwksUrl: env.WORKOS_JWKS_URL } : {}),
    ...(env.WORKOS_ISSUER ? { workosIssuer: env.WORKOS_ISSUER } : {}),
  };
}
