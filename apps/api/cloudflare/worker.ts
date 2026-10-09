import { Container } from "@cloudflare/containers";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

// Optional API features use the same secret names as the existing Bun service.
type OptionalSecrets = Partial<
  Record<
    | "API_SIGNING_KEY_PREVIOUS"
    | "PROFILE_PROXY_SECRET"
    | "CLOUDFLARE_ACCOUNT_ID"
    | "CLOUDFLARE_ZONE_ID"
    | "CLOUDFLARE_API_TOKEN"
    | "CLOUDFLARE_TUNNEL_DOMAIN"
    | "REMOTE_TEST_USER_IDS"
    | "S3_ENDPOINT"
    | "S3_BUCKET"
    | "S3_ACCESS_KEY_ID"
    | "S3_SECRET_ACCESS_KEY"
    | "S3_PUBLIC_BASE_URL"
    | "S3_REGION",
    string
  >
>;

export class AccountApi extends Container<Cloudflare.Env & OptionalSecrets> {
  override defaultPort = 8788;
  override sleepAfter = "30m";
  override enableInternet = true;
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
    ...Object.fromEntries(
      (
        [
          "API_SIGNING_KEY_PREVIOUS",
          "PROFILE_PROXY_SECRET",
          "CLOUDFLARE_ACCOUNT_ID",
          "CLOUDFLARE_ZONE_ID",
          "CLOUDFLARE_API_TOKEN",
          "CLOUDFLARE_TUNNEL_DOMAIN",
          "REMOTE_TEST_USER_IDS",
          "S3_ENDPOINT",
          "S3_BUCKET",
          "S3_ACCESS_KEY_ID",
          "S3_SECRET_ACCESS_KEY",
          "S3_PUBLIC_BASE_URL",
          "S3_REGION",
        ] as const
      ).flatMap((key) => (this.env[key] ? [[key, this.env[key]]] : [])),
    ),
  };
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
      return await env.ACCOUNT_API.getByName("account-api").fetch(
        new Request(request, { headers }),
      );
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
