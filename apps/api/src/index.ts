import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadApiConfig } from "./config";
import { runMigrations } from "./db/migrate";

async function main(): Promise<void> {
  const config = loadApiConfig(process.env);
  await runMigrations(config.databaseUrl);

  const { app, identity, pool, cleanup } = await createApp(config);

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[api] listening on http://localhost:${info.port}`);
  });

  let maintenance: Promise<void> | undefined;
  const sweep = () => {
    if (maintenance) return;
    maintenance = cleanup()
      .catch(() => console.warn("[api] Tunnel cleanup pending"))
      .finally(() => {
        maintenance = undefined;
      });
  };
  const cleanupTimer = setInterval(sweep, 30_000);
  cleanupTimer.unref();
  sweep();
  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] received ${signal}, shutting down`);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    clearInterval(cleanupTimer);
    await maintenance;
    await identity.close();
    await pool.end();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("[api] fatal startup error", error);
  process.exit(1);
});
