// FILE: opencodeApiCompatibility.test.ts
// Purpose: Preserve non-success HTML errors while retrying OpenCode 2 SPA fallbacks.
import { describe, expect, it } from "vitest";
import { createOpenCodeApiCompatibleFetch } from "./opencodeRuntime.ts";

describe("OpenCode 2 HTML route fallback", () => {
  it.each([400, 401, 403, 404, 429, 502, 503])(
    "does not retry a real HTTP %i HTML error",
    async (status) => {
      const paths: string[] = [];
      const fetchCompatible = createOpenCodeApiCompatibleFetch(async (input) => {
        const request = input instanceof Request ? input : new Request(String(input));
        paths.push(new URL(request.url).pathname);
        return new Response("<html>upstream error</html>", {
          status,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      });
      const response = await fetchCompatible("http://127.0.0.1:4096/provider");
      expect(response.status).toBe(status);
      expect(paths).toEqual(["/provider"]);
    },
  );

  it("continues retrying a successful HTML SPA fallback", async () => {
    const paths: string[] = [];
    const fetchCompatible = createOpenCodeApiCompatibleFetch(async (input) => {
      const request = input instanceof Request ? input : new Request(String(input));
      const path = new URL(request.url).pathname;
      paths.push(path);
      return new Response(path === "/provider" ? "<html>OpenCode</html>" : "{}", {
        headers: {
          "content-type": path === "/provider" ? "text/html" : "application/json",
        },
      });
    });
    expect((await fetchCompatible("http://127.0.0.1:4096/provider")).status).toBe(200);
    expect(paths).toEqual(["/provider", "/api/provider"]);
  });
});
