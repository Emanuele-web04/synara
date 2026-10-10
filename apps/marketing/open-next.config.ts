import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";

// ISR-heavy site on Workers: default caches are per-isolate, so R2 holds the cache and a Durable Object queue drives time-based revalidations
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  queue: doQueue,
});
