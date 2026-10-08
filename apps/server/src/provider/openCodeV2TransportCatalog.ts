import { setTimeout as delay } from "node:timers/promises";
import type { OpenCodeClient } from "./openCodeClient.ts";
import { normalizeOpenCodeV2ProviderList } from "./openCodeV2Data.ts";
import { v2Array } from "./openCodeV2Json.ts";
import { requestOpenCodeV2, type OpenCodeV2HttpContext } from "./openCodeV2TransportHttp.ts";

export function createOpenCodeV2CatalogClient(
  http: OpenCodeV2HttpContext,
): OpenCodeClient["provider"] {
  return {
    list: async (parameters, options) => {
      const deadline = AbortSignal.any([
        ...(options?.signal ? [options.signal] : []),
        AbortSignal.timeout(30_000),
      ]);
      const settlingSignal = AbortSignal.any([deadline, AbortSignal.timeout(15_000)]);
      let models: unknown[] = [];
      // A cold server answers health checks before its model inventory settles.
      // Retry only raw empty lists; filtered/disabled catalogs remain authoritative.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        settlingSignal.throwIfAborted();
        models = v2Array(
          await requestOpenCodeV2(
            http,
            "/api/model",
            "GET",
            undefined,
            settlingSignal,
            parameters?.directory,
          ),
          "models",
        );
        if (models.length > 0 || attempt === 4) break;
        await delay(2_000, undefined, { signal: settlingSignal });
      }
      deadline.throwIfAborted();
      const providers = await requestOpenCodeV2(
        http,
        "/api/provider",
        "GET",
        undefined,
        deadline,
        parameters?.directory,
      );
      return { data: normalizeOpenCodeV2ProviderList(models, providers) };
    },
  };
}
