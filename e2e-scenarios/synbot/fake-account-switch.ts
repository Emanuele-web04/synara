// A front for the fake Account API (fake-account.ts), for the Stable Alto lifecycle scenarios
// only (`start-app.ts --stable --alto-ui`).
//
// It forwards every call to the fake account and adds what those scenarios need on top:
//   - checkout and portal links (`POST /api/v1/billing/checkout|portal`), always a fixed Polar
//     sandbox URL that the scenario never opens;
//   - a network switch: `POST /__scenario/network {"up": false}` drops every Account API call
//     (the socket is destroyed, as when the network is gone) until `{"up": true}`.
// Scenario calls (`/__scenario/*`) always go through, so a test can switch billing while offline.
import * as nodeHttp from "node:http";

const CHECKOUT_URL = "https://sandbox.polar.sh/checkout/scenario";

export function startAccountSwitch(host: string, port: number, upstream: string) {
  let up = true;
  let dropped = 0;
  let checkouts = 0;
  const server = nodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (status: number, data: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(data));
      };
      const route = `${request.method} ${url.pathname}`;
      if (route === "POST /__scenario/network") {
        try {
          up = (JSON.parse(body.toString("utf8")) as { up?: unknown }).up !== false;
        } catch {
          return json(400, {});
        }
        return json(200, { up });
      }
      if (route === "GET /__scenario/network") return json(200, { up, dropped, checkouts });
      if (!up && !url.pathname.startsWith("/__scenario/")) {
        dropped += 1;
        request.socket.destroy();
        return;
      }
      if (route === "POST /api/v1/billing/checkout" || route === "POST /api/v1/billing/portal") {
        checkouts += 1;
        return json(200, { url: CHECKOUT_URL, environment: "sandbox" });
      }
      const headers = Object.fromEntries(
        Object.entries(request.headers).flatMap(([key, value]) =>
          typeof value === "string" && key !== "host" && key !== "content-length"
            ? [[key, value]]
            : [],
        ),
      );
      fetch(`${upstream}${url.pathname}${url.search}`, {
        method: request.method ?? "GET",
        headers,
        ...(body.length > 0 ? { body } : {}),
      })
        .then(async (answer) => {
          response.writeHead(answer.status, {
            "content-type": answer.headers.get("content-type") ?? "application/json",
          });
          response.end(Buffer.from(await answer.arrayBuffer()));
        })
        .catch(() => {
          response.writeHead(502);
          response.end();
        });
    });
  });
  return new Promise<{ readonly url: string }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ url: `http://${host}:${port}` }));
  });
}
