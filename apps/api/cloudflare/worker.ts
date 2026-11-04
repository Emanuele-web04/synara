import { Container } from "@cloudflare/containers";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

// Only these billing bindings cross from Worker storage into the API process.
// Their values are never returned by the public Worker or written to logs.
const POLAR_BINDINGS = [
  "POLAR_BILLING_ENABLED",
  "POLAR_ENVIRONMENT",
  "POLAR_PRODUCTION_PAYMENTS_ENABLED",
  "POLAR_REMOTE_ACCESS_ENFORCED",
  "POLAR_RETURN_ORIGINS",
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "POLAR_ORGANIZATION_ID",
  "POLAR_MONTHLY_PRODUCT_ID",
  "POLAR_YEARLY_PRODUCT_ID",
  "POLAR_DESKTOP_BENEFIT_ID",
  "POLAR_CHECKOUT_SUCCESS_URL",
  "POLAR_PORTAL_RETURN_URL",
  "POLAR_EXPECTED_CURRENCY",
  "POLAR_EXPECTED_MONTHLY_AMOUNT_MINOR",
  "POLAR_EXPECTED_YEARLY_AMOUNT_MINOR",
  "POLAR_EXPECTED_TAX_BEHAVIOR",
] as const;
const RUNTIME_CONFIG_KEY = "account-api-runtime-config-sha256";
const RUNTIME_STOP_TIMEOUT_MS = 15_000;

// Optional API features use the same secret names as the existing Bun service.
type OptionalSecrets = Partial<
  Record<
    | (typeof POLAR_BINDINGS)[number]
    | "API_SIGNING_KEY_PREVIOUS"
    | "WORKOS_IDENTITY_MAP"
    | "PROFILE_PROXY_SECRET"
    | "CLOUDFLARE_ACCOUNT_ID"
    | "CLOUDFLARE_ZONE_ID"
    | "CLOUDFLARE_API_TOKEN"
    | "CLOUDFLARE_TUNNEL_DOMAIN"
    | "REMOTE_TEST_USER_IDS"
    | "REMOTE_TEST_ADDITIONAL_USER_IDS"
    | "REMOTE_BETA_ACCESS_ENABLED"
    | "S3_ENDPOINT"
    | "S3_BUCKET"
    | "S3_ACCESS_KEY_ID"
    | "S3_SECRET_ACCESS_KEY"
    | "S3_PUBLIC_BASE_URL"
    | "S3_REGION"
    | "APNS_PRIVATE_KEY"
    | "APNS_KEY_ID"
    | "APNS_PRODUCTION_PRIVATE_KEY"
    | "APNS_PRODUCTION_KEY_ID"
    | "APNS_TEAM_ID"
    | "APNS_BUNDLE_ID"
    | "APNS_ENVIRONMENT",
    string
  >
>;

export class AccountApi extends Container<Cloudflare.Env & OptionalSecrets> {
  override defaultPort = 8788;
  override sleepAfter = "30m";
  override enableInternet = true;
  // Observe restarts without logging the runtime environment or its credentials.
  override onStart() {
    console.info("[account-api] Container started");
  }
  override envVars = {
    NODE_ENV: "production",
    IDENTITY_PROVIDER: "workos",
    PORT: "8788",
    TRUSTED_PROXY_HOPS: "1",
    DATABASE_URL: this.env.DATABASE_URL,
    WORKOS_API_KEY: this.env.WORKOS_API_KEY,
    WORKOS_CLIENT_ID: this.env.WORKOS_CLIENT_ID,
    ACCOUNT_BASE_URL: this.env.ACCOUNT_BASE_URL,
    API_PUBLIC_URL: this.env.API_PUBLIC_URL,
    API_SIGNING_KEY: this.env.API_SIGNING_KEY,
    POLAR_BILLING_ENABLED: this.env.POLAR_BILLING_ENABLED ?? "false",
    POLAR_PRODUCTION_PAYMENTS_ENABLED: this.env.POLAR_PRODUCTION_PAYMENTS_ENABLED ?? "false",
    POLAR_REMOTE_ACCESS_ENFORCED: this.env.POLAR_REMOTE_ACCESS_ENFORCED ?? "false",
    ...Object.fromEntries(
      // Empty configured values must reach the API's strict parser, not become defaults.
      POLAR_BINDINGS.flatMap((key) => (this.env[key] !== undefined ? [[key, this.env[key]]] : [])),
    ),
    ...Object.fromEntries(
      (
        [
          "API_SIGNING_KEY_PREVIOUS",
          "WORKOS_IDENTITY_MAP",
          "PROFILE_PROXY_SECRET",
          "CLOUDFLARE_ACCOUNT_ID",
          "CLOUDFLARE_ZONE_ID",
          "CLOUDFLARE_API_TOKEN",
          "CLOUDFLARE_TUNNEL_DOMAIN",
          "REMOTE_TEST_USER_IDS",
          "REMOTE_BETA_ACCESS_ENABLED",
          "S3_ENDPOINT",
          "S3_BUCKET",
          "S3_ACCESS_KEY_ID",
          "S3_SECRET_ACCESS_KEY",
          "S3_PUBLIC_BASE_URL",
          "S3_REGION",
          "APNS_PRIVATE_KEY",
          "APNS_KEY_ID",
          "APNS_PRODUCTION_PRIVATE_KEY",
          "APNS_PRODUCTION_KEY_ID",
          "APNS_TEAM_ID",
          "APNS_BUNDLE_ID",
          "APNS_ENVIRONMENT",
        ] as const
      ).flatMap((key) => (this.env[key] ? [[key, this.env[key]]] : [])),
    ),
    // Add trial users without replacing an existing, write-only Worker secret.
    ...(this.env.REMOTE_TEST_ADDITIONAL_USER_IDS
      ? {
          REMOTE_TEST_USER_IDS: [
            this.env.REMOTE_TEST_USER_IDS,
            this.env.REMOTE_TEST_ADDITIONAL_USER_IDS,
          ]
            .filter(Boolean)
            .join(","),
        }
      : {}),
  };

  private runtimeConfiguration: Promise<void> | undefined;

  private ensureRuntimeConfiguration(): Promise<void> {
    if (!this.runtimeConfiguration) {
      this.runtimeConfiguration = (async () => {
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify(
              Object.entries(this.envVars).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            ),
          )
          .digest("hex");
        const previous = await this.ctx.storage.get<string>(RUNTIME_CONFIG_KEY);
        if (previous === fingerprint) return;

        // A warm container keeps its old process environment across Worker updates.
        // Never forward admission to that process while its billing policy is unknown.
        const container = this.ctx.container;
        if (container?.running) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              (async () => {
                const stopped = container.monitor().catch(() => {});
                await this.stop("SIGTERM");
                await stopped;
                if (container.running) throw new Error("API runtime configuration is not ready");
              })(),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error("API runtime configuration is not ready")),
                  RUNTIME_STOP_TIMEOUT_MS,
                );
              }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
        }
        // The existing SDK bounds startup and port readiness; persist only a ready process.
        await this.startAndWaitForPorts();
        await this.ctx.storage.put(RUNTIME_CONFIG_KEY, fingerprint);
      })().catch((error) => {
        this.runtimeConfiguration = undefined;
        throw error;
      });
    }
    return this.runtimeConfiguration;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureRuntimeConfiguration();
    // A matching stored config does not prove a process survived sleep or a crash.
    // Use the SDK's throwing readiness path before its fetch can expose startup errors.
    if (!this.ctx.container?.running) {
      try {
        await this.startAndWaitForPorts();
      } catch (error) {
        // Do not reuse a historical readiness claim after a failed restart.
        this.runtimeConfiguration = undefined;
        await this.ctx.storage.delete(RUNTIME_CONFIG_KEY);
        throw error;
      }
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request, env) {
    const headers = new Headers(request.headers);
    // Replace caller-supplied proxy chains at the Cloudflare ingress boundary.
    headers.delete("x-forwarded-for");
    // Cross-account subrequests have a shared Cloudflare IP. Only our legacy
    // relay may supply the original client address, for rate limiting only.
    const expected = new TextEncoder().encode(env.MIGRATION_PROXY_SECRET ?? "");
    const supplied = new TextEncoder().encode(headers.get("x-synara-migration-secret") ?? "");
    const relayIp = headers.get("x-synara-client-ip");
    const trustedRelay =
      expected.length > 0 &&
      expected.length === supplied.length &&
      timingSafeEqual(expected, supplied);
    const ip = trustedRelay && relayIp && isIP(relayIp) ? relayIp : headers.get("cf-connecting-ip");
    headers.delete("x-synara-migration-secret");
    headers.delete("x-synara-client-ip");
    if (ip && isIP(ip)) headers.set("x-forwarded-for", ip);
    try {
      // One instance preserves the API's existing process-local rate limits.
      const response = await env.ACCOUNT_API.getByName("account-api").fetch(
        new Request(request, { headers }),
      );
      // The SDK can return raw transport/startup errors instead of throwing.
      // Preserve application JSON errors, streams and WebSocket upgrades verbatim.
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if ((response.status === 500 || response.status === 429) && contentType === "text/plain")
        throw new Error("Account container transport is unavailable");
      return response;
    } catch {
      // Startup failures can contain connection details; never log raw errors.
      console.error("[account-api] Container unavailable");
      return Response.json(
        { error: "internal_error", message: "Account service temporarily unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
      );
    }
  },
} satisfies ExportedHandler<Cloudflare.Env & { MIGRATION_PROXY_SECRET?: string }>;
