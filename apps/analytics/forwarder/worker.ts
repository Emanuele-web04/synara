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
    // Retire old upload URLs before reading or forwarding crash memory.
    if (/^\/v1\/crash(?:\/|$)/.test(url.pathname) || /^\/api\/dumps(?:\/|$)/.test(url.pathname))
      return new Response("raw crash uploads retired", { status: 410 });
    if (!env.TARGET) {
      return new Response("migrating, retry later", {
        status: 503,
        headers: { "retry-after": "600" },
      });
    }
    // Assign components so a leading // stays a path on the configured origin.
    const target = new URL(env.TARGET);
    target.pathname = url.pathname;
    target.search = url.search;
    target.hash = "";
    if (!url.pathname.startsWith("/v1/")) return Response.redirect(target.toString(), 308);
    return fetch(new Request(target, request));
  },
} satisfies ExportedHandler<ForwarderEnv>;
