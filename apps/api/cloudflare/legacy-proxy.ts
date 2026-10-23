import { isIP } from "node:net";

// Keep the old Durable Object class available without routing traffic to it.
// Its retained state and image remain usable for an explicit recovery.
export { AccountApi } from "./worker";

function unavailable() {
  return Response.json(
    { error: "internal_error", message: "Account service temporarily unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
  );
}

export default {
  async fetch(request, env) {
    if (!env.MIGRATION_TARGET || !env.MIGRATION_PROXY_SECRET) return unavailable();
    try {
      const target = new URL(env.MIGRATION_TARGET);
      if (target.protocol !== "https:" || target.origin !== env.MIGRATION_TARGET) {
        return unavailable();
      }
      const source = new URL(request.url);
      target.pathname = source.pathname;
      target.search = source.search;
      const headers = new Headers(request.headers);
      headers.delete("x-synara-client-ip");
      headers.delete("x-synara-migration-secret");
      const ip = headers.get("cf-connecting-ip");
      if (ip && isIP(ip)) headers.set("x-synara-client-ip", ip);
      headers.set("x-synara-migration-secret", env.MIGRATION_PROXY_SECRET);
      // Stream uploads and responses. Never send credentials to a redirect target.
      return await fetch(
        new Request(target, new Request(request, { headers, redirect: "manual" })),
      );
    } catch {
      return unavailable();
    }
  },
} satisfies ExportedHandler<{
  MIGRATION_TARGET?: string;
  MIGRATION_PROXY_SECRET?: string;
}>;
