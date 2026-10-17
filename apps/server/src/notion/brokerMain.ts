/** Operator entrypoint: run behind a TLS reverse proxy, never inside Electron. */
import { createServer } from "node:http";
import { createNotionBrokerStore } from "./brokerStore.ts";
import { NotionOAuthBroker } from "./oauthBroker.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} on the hosted OAuth backend.`);
  return value;
};
const port = Number(process.env.SYNARA_NOTION_BROKER_PORT ?? 4387);
if (!Number.isInteger(port) || port < 1024 || port > 65_535)
  throw new Error("Invalid Notion broker port.");
const broker = new NotionOAuthBroker({
  origin: required("SYNARA_NOTION_BROKER_ORIGIN"),
  clientId: required("NOTION_CLIENT_ID"),
  clientSecret: required("NOTION_CLIENT_SECRET"),
  ...createNotionBrokerStore(
    required("SYNARA_NOTION_BROKER_STORE"),
    required("SYNARA_NOTION_BROKER_KEY"),
  ),
});
await broker.init();
const server = createServer(
  { maxHeaderSize: 8_192, requestTimeout: 20_000, headersTimeout: 10_000 },
  async (incoming, outgoing) => {
    try {
      if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) {
        outgoing.writeHead(400).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.byteLength;
        if (size > 8_192) {
          outgoing.writeHead(413).end();
          return;
        }
        chunks.push(bytes);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (typeof value === "string") headers.set(name, value);
      const request = new Request(`${broker.origin}${incoming.url}`, {
        method: incoming.method ?? "GET",
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await broker.handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing
        .writeHead(500, { "Cache-Control": "no-store" })
        .end("The OAuth backend could not process this request.");
    }
  },
);
server.listen(port, "127.0.0.1");
let maintaining = false;
const maintenance = setInterval(() => {
  if (maintaining) return;
  maintaining = true;
  void broker
    .expireUnclaimed()
    .catch(() => {
      console.warn("Notion OAuth maintenance requires operator attention.");
    })
    .finally(() => {
      maintaining = false;
    });
}, 60_000);
maintenance.unref();
for (const event of ["SIGINT", "SIGTERM"] as const)
  process.once(event, () => {
    clearInterval(maintenance);
    server.close(() => {
      void broker.close().finally(() => {
        process.exitCode = 0;
      });
    });
  });
