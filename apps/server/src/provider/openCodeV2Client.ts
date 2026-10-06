import { createOpenCodeV2McpClient } from "./openCodeV2TransportMcp.ts";
import {
  grantOpenCodeV2SessionPermission,
  type OpenCodeV2SessionPermissionState,
} from "./openCodeV2TransportPermissions.ts";
import type { PermissionRequest } from "@opencode-ai/sdk/v2";
import type { OpenCodeClient } from "./openCodeClient.ts";
import {
  normalizeOpenCodeV2Agents,
  normalizeOpenCodeV2Commands,
  normalizeOpenCodeV2FormAnswers,
  normalizeOpenCodeV2Path,
  normalizeOpenCodeV2Permissions,
  normalizeOpenCodeV2ProviderList,
  normalizeOpenCodeV2Questions,
} from "./openCodeV2Data.ts";
import { subscribeOpenCodeV2Events } from "./openCodeV2Events.ts";
import { createOpenCodeV2EventNormalizer } from "./openCodeV2EventNormalization.ts";
import { UnsupportedOpenCodeV2FormError } from "./openCodeV2Forms.ts";
import {
  createOpenCodeV2HttpContext,
  openCodeV2Object,
  requestOpenCodeV2,
  usesCurrentOpenCodeV2Fields,
  type OpenCodeV2ClientOptions,
} from "./openCodeV2TransportHttp.ts";
import { createOpenCodeV2SessionClient } from "./openCodeV2TransportSession.ts";

export type { OpenCodeV2ClientOptions } from "./openCodeV2TransportHttp.ts";

/** V2 endpoints are selected explicitly; an operation never falls back to a legacy route. */
export function createOpenCodeV2Client(input: OpenCodeV2ClientOptions): OpenCodeClient {
  const http = createOpenCodeV2HttpContext(input);
  const currentFields = usesCurrentOpenCodeV2Fields(input.version);
  // Tool calls may finish after the runtime reconnects its SSE subscription.
  const normalizeEvent = createOpenCodeV2EventNormalizer();
  const pendingPermissions = new Map<string, PermissionRequest>();
  const sessionPermissions: OpenCodeV2SessionPermissionState = {
    rules: new Map(),
    grants: new Map(),
  };
  const pendingForms = new Map<string, unknown>();
  const listPermissions: OpenCodeClient["permission"]["list"] = async (parameters, options) => {
    const data = normalizeOpenCodeV2Permissions(
      await requestOpenCodeV2(
        http,
        "/api/permission/request",
        "GET",
        undefined,
        options?.signal,
        parameters?.directory,
      ),
    );
    pendingPermissions.clear();
    for (const request of data) pendingPermissions.set(request.id, request);
    return { data };
  };
  const listQuestions: OpenCodeClient["question"]["list"] = async (parameters, options) => {
    const value = await requestOpenCodeV2(
      http,
      "/api/form",
      "GET",
      undefined,
      options?.signal,
      parameters?.directory,
    );
    if (!Array.isArray(value)) throw new Error("OpenCode v2 returned no pending form list.");
    pendingForms.clear();
    for (const form of value) {
      const record = openCodeV2Object(form);
      if (typeof record.id === "string") pendingForms.set(record.id, form);
    }
    return { data: normalizeOpenCodeV2Questions(value) };
  };
  const formById = async (
    id: string,
    options?: { signal?: AbortSignal | null | undefined },
    directory?: string,
  ) => {
    if (!pendingForms.has(id)) {
      try {
        await listQuestions(
          directory ? { directory } : {},
          options?.signal ? { signal: options.signal } : undefined,
        );
      } catch (error) {
        // Unsupported forms must still be cancelable using their raw session-scoped identity.
        if (!(error instanceof UnsupportedOpenCodeV2FormError) || !pendingForms.has(id))
          throw error;
      }
    }
    const form = pendingForms.get(id);
    const sessionID = openCodeV2Object(form).sessionID;
    if (!form || typeof sessionID !== "string")
      throw new Error("OpenCode v2 pending form was not found; it may already be resolved.");
    return {
      form,
      path: `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(id)}`,
    };
  };
  return {
    session: createOpenCodeV2SessionClient(http, input.directory, sessionPermissions),
    provider: {
      list: async (parameters, options) => {
        const models = await requestOpenCodeV2(
          http,
          "/api/model",
          "GET",
          undefined,
          options?.signal,
          parameters?.directory,
        );
        const providers = await requestOpenCodeV2(
          http,
          "/api/provider",
          "GET",
          undefined,
          options?.signal,
          parameters?.directory,
        );
        return { data: normalizeOpenCodeV2ProviderList(models, providers) };
      },
    },
    app: {
      agents: async (parameters, options) => ({
        data: normalizeOpenCodeV2Agents(
          await requestOpenCodeV2(
            http,
            "/api/agent",
            "GET",
            undefined,
            options?.signal,
            parameters?.directory,
          ),
        ),
      }),
    },
    path: {
      get: async (parameters, options) => ({
        data: normalizeOpenCodeV2Path(
          await requestOpenCodeV2(
            http,
            "/api/location",
            "GET",
            undefined,
            options?.signal,
            parameters?.directory,
          ),
        ),
      }),
    },
    command: {
      list: async (parameters, options) => ({
        data: normalizeOpenCodeV2Commands(
          await requestOpenCodeV2(
            http,
            "/api/command",
            "GET",
            undefined,
            options?.signal,
            parameters?.directory,
          ),
        ),
      }),
    },
    experimental: {
      console: {
        get: async () => {
          throw new Error("OpenCode v2 does not expose the legacy experimental console API.");
        },
      },
    },
    permission: {
      list: listPermissions,
      reply: async (parameters, options) => {
        if (!pendingPermissions.has(parameters.requestID))
          await listPermissions(
            parameters.directory ? { directory: parameters.directory } : {},
            options,
          );
        const request = pendingPermissions.get(parameters.requestID);
        if (!request)
          throw new Error(
            "OpenCode v2 pending permission was not found; it may already be resolved.",
          );
        if (!parameters.reply)
          throw new Error("OpenCode v2 permission reply requires an explicit decision.");
        if (parameters.reply === "always")
          await grantOpenCodeV2SessionPermission(
            http,
            sessionPermissions,
            request,
            options?.signal,
            parameters.directory,
          );
        await requestOpenCodeV2(
          http,
          `/api/session/${encodeURIComponent(request.sessionID)}/permission/${encodeURIComponent(parameters.requestID)}/reply`,
          "POST",
          {
            [currentFields ? "decision" : "reply"]:
              parameters.reply === "always" ? "once" : parameters.reply,
            ...(parameters.message ? { message: parameters.message } : {}),
          },
          options?.signal,
          parameters.directory,
        );
        pendingPermissions.delete(parameters.requestID);
        return { data: true };
      },
    },
    question: {
      list: listQuestions,
      reply: async (parameters, options) => {
        const { form, path } = await formById(parameters.requestID, options, parameters.directory);
        await requestOpenCodeV2(
          http,
          `${path}/reply`,
          "POST",
          { answer: normalizeOpenCodeV2FormAnswers(form, parameters.answers ?? []) },
          options?.signal,
          parameters.directory,
        );
        pendingForms.delete(parameters.requestID);
        return { data: true };
      },
      reject: async (parameters, options) => {
        const { path } = await formById(parameters.requestID, options, parameters.directory);
        await requestOpenCodeV2(
          http,
          path,
          "DELETE",
          undefined,
          options?.signal,
          parameters.directory,
        );
        pendingForms.delete(parameters.requestID);
        return { data: true };
      },
    },
    mcp: createOpenCodeV2McpClient(http),
    event: {
      subscribe: async (parameters, options) => {
        const headers = new Headers(http.headers);
        if (parameters?.directory)
          headers.set("x-opencode-directory", encodeURIComponent(parameters.directory));
        return subscribeOpenCodeV2Events({
          baseUrl: http.baseUrl,
          headers,
          fetchImpl: http.fetch,
          normalize: normalizeEvent,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      },
    },
  };
}
