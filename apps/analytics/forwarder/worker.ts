// Stand-in for the old worker URL that shipped betas still hardcode.
// TARGET unset: /v1/* answers 503 so clients keep events queued on disk
// (freeze while data is exported). TARGET set: /v1/* is proxied there and the
// dashboard redirects.

export interface ForwarderEnv {
  TARGET?: string;
}

export default {
  async fetch(request: Request, env: ForwarderEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!env.TARGET) {
      return new Response("migrating, retry later", {
        status: 503,
        headers: { "retry-after": "600" },
      });
    }
    const target = new URL(url.pathname + url.search, env.TARGET);
    if (!url.pathname.startsWith("/v1/")) return Response.redirect(target.toString(), 308);
    return fetch(new Request(target, request));
  },
} satisfies ExportedHandler<ForwarderEnv>;
