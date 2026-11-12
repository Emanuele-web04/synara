import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadApiConfig } from "./config";
import { runMigrations } from "./db/migrate";
import { createPerfRecorder, isPerfEnabled } from "./perf";

async function main(): Promise<void> {
  const config = loadApiConfig(process.env);
  await runMigrations(config.databaseUrl);

  // Opt-in (SYNARA_API_PERF=1): per-route timings in the log and a Server-Timing header.
  const perf = isPerfEnabled(process.env) ? createPerfRecorder() : undefined;
  perf?.instrumentFetch();
  const stopPerfReporting = perf?.startReporting();
  const timed = <A>(name: string, run: () => Promise<A>) => (perf ? perf.job(name, run) : run());

  const { app, identity, pool, cleanup, flushLiveActivities, flushBilling } = await createApp(
    config,
    perf ? { perf } : {},
  );

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[api] listening on http://localhost:${info.port}`);
  });

  let shuttingDown = false;
  let maintenance: Promise<void> | undefined;
  const sweep = () => {
    if (maintenance) return;
    maintenance = timed("cleanup", cleanup)
      .catch(() => console.warn("[api] Maintenance pending"))
      .finally(() => {
        maintenance = undefined;
      });
  };
  let pushMaintenance: Promise<void> | undefined;
  const pushSweep = () => {
    if (pushMaintenance) return;
    pushMaintenance = timed("push-flush", flushLiveActivities)
      .catch(() => console.warn("[api] Push delivery pending"))
      .finally(() => {
        pushMaintenance = undefined;
      });
  };
  // Billing outages must not hold tunnel/account housekeeping behind a slow provider.
  let billingMaintenance: Promise<void> | undefined;
  const billingSweep = () => {
    if (shuttingDown || !flushBilling || billingMaintenance) return;
    billingMaintenance = timed("billing-flush", flushBilling)
      .catch(() => console.warn("[api] Billing reconciliation pending"))
      .finally(() => {
        billingMaintenance = undefined;
      });
  };
  const billingTimer = flushBilling ? setInterval(billingSweep, 30_000) : undefined;
  billingTimer?.unref();
  billingSweep();
  const pushTimer = setInterval(pushSweep, 5_000);
  pushTimer.unref();
  pushSweep();
  const cleanupTimer = setInterval(sweep, 30_000);
  cleanupTimer.unref();
  sweep();
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] received ${signal}, shutting down`);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    clearInterval(cleanupTimer);
    clearInterval(pushTimer);
    if (billingTimer) clearInterval(billingTimer);
    stopPerfReporting?.();
    await pushMaintenance;
    await billingMaintenance;
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
