import type { McpStatus } from "@opencode-ai/sdk/v2";
import { setTimeout as delay } from "node:timers/promises";
import type { OpenCodeClient } from "./openCodeClient.ts";
import {
  openCodeV2Object,
  requestOpenCodeV2,
  type OpenCodeV2HttpContext,
} from "./openCodeV2TransportHttp.ts";

export function createOpenCodeV2McpClient(http: OpenCodeV2HttpContext): OpenCodeClient["mcp"] {
  return {
    add: async (parameters, options) => {
      const config = parameters?.config;
      if (!parameters?.name || !config)
        throw new Error("OpenCode v2 MCP registration requires a name and configuration.");
      const { enabled, timeout, ...rest } = config;
      // The v2 runtime endpoint updates a Location-scoped in-memory override map.
      // Do not use persisted settings/configuration endpoints for task gateway credentials.
      await requestOpenCodeV2(
        http,
        `/api/experimental/mcp/${encodeURIComponent(parameters.name)}`,
        "PUT",
        {
          config: {
            ...rest,
            codemode: false,
            ...(enabled === undefined ? {} : { disabled: !enabled }),
            ...(timeout === undefined
              ? {}
              : { timeout: { startup: timeout, catalog: timeout, execution: timeout } }),
          },
        },
        options?.signal,
        parameters.directory,
      );
      const signal = AbortSignal.any([
        ...(options?.signal ? [options.signal] : []),
        AbortSignal.timeout(timeout ?? 15_000),
      ]);
      let value: unknown;
      do {
        value = await requestOpenCodeV2(
          http,
          "/api/mcp",
          "GET",
          undefined,
          signal,
          parameters.directory,
        );
        if (!Array.isArray(value))
          throw new Error("OpenCode v2 MCP listing returned no server list.");
        const registered = value.find((item) => openCodeV2Object(item).name === parameters.name);
        if (!registered) throw new Error("OpenCode v2 did not register the requested MCP server.");
        if (openCodeV2Object(openCodeV2Object(registered).status).status !== "pending") break;
        await delay(100, undefined, { signal });
      } while (true);
      if (!Array.isArray(value))
        throw new Error("OpenCode v2 MCP listing returned no server list.");
      const data: Record<string, McpStatus> = {};
      for (const item of value) {
        const server = openCodeV2Object(item);
        const status = openCodeV2Object(server.status);
        if (typeof server.name !== "string") continue;
        if (status.status === "connected") data[server.name] = { status: "connected" };
        else if (status.status === "failed")
          data[server.name] = {
            status: "failed",
            error: typeof status.error === "string" ? status.error : "Connection failed",
          };
        else if (status.status === "needs_auth") data[server.name] = { status: "needs_auth" };
        else if (status.status === "disabled") data[server.name] = { status: "disabled" };
        else data[server.name] = { status: "failed", error: "MCP server is not ready." };
      }
      return { data };
    },
  };
}
