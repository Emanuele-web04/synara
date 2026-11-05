// Keep previously shared profile links usable after the account migration.
export default {
  fetch(request: Request, env: { PROFILES_PUBLIC_ORIGIN: string }) {
    const target = new URL(env.PROFILES_PUBLIC_ORIGIN);
    if (target.protocol !== "https:" || target.origin !== env.PROFILES_PUBLIC_ORIGIN) {
      return new Response("Profile service temporarily unavailable", { status: 503 });
    }
    const source = new URL(request.url);
    target.pathname = source.pathname;
    target.search = source.search;
    return Response.redirect(target.href, 308);
  },
};
