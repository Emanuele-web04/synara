import { listOpenCodeV2Pages } from "./openCodeV2TransportPages.ts";
import { createOpenCodeV2PromptAsync } from "./openCodeV2TransportPrompt.ts";
import {
  isPlanRules,
  openCodeV2PermissionRules,
  type OpenCodeV2SessionPermissionState,
} from "./openCodeV2TransportPermissions.ts";
import type { OpenCodeClient } from "./openCodeClient.ts";
import { normalizeOpenCodeV2Messages, normalizeOpenCodeV2Session } from "./openCodeV2Data.ts";
import {
  openCodeV2Object,
  sessionPath,
  requestOpenCodeV2,
  type OpenCodeV2HttpContext,
} from "./openCodeV2TransportHttp.ts";

export function createOpenCodeV2SessionClient(
  http: OpenCodeV2HttpContext,
  directory?: string,
  permissions: OpenCodeV2SessionPermissionState = { rules: new Map(), grants: new Map() },
): OpenCodeClient["session"] {
  const knownSessions = new Set<string>();
  const read = async (id: string, signal?: AbortSignal | null, dir?: string) => {
    const session = normalizeOpenCodeV2Session(
      await requestOpenCodeV2(http, sessionPath(id), "GET", undefined, signal, dir),
    );
    knownSessions.add(id);
    if (!permissions.rules.has(id)) permissions.rules.set(id, session.permission ?? []);
    return session;
  };
  const messages = async (
    id: string,
    signal?: AbortSignal | null,
    dir?: string,
    limit?: number,
  ) => {
    const resolvedDirectory = dir ?? directory;
    return normalizeOpenCodeV2Messages(
      await listOpenCodeV2Pages(http, sessionPath(id, "/message"), signal, dir, limit),
      { sessionID: id, ...(resolvedDirectory ? { directory: resolvedDirectory } : {}) },
    );
  };
  const sendPrompt = createOpenCodeV2PromptAsync(http);
  return {
    create: async (input, options) => {
      if (input?.workspaceID)
        throw new Error("OpenCode v2 session creation does not support legacy workspaceID.");
      const data = normalizeOpenCodeV2Session(
        await requestOpenCodeV2(
          http,
          "/api/session",
          "POST",
          {
            location: { directory: input?.directory ?? directory },
            title: input?.title,
            parentID: input?.parentID,
            agent: input?.agent,
            model: input?.model,
            metadata: input?.metadata,
            permissions: openCodeV2PermissionRules(input?.permission),
          },
          options?.signal,
          input?.directory,
        ),
      );
      knownSessions.add(data.id);
      permissions.rules.set(data.id, input?.permission ?? data.permission ?? []);
      return { data };
    },
    get: async (input, options) => ({
      data: await read(input.sessionID, options?.signal, input.directory),
    }),
    update: async (input, options) => {
      if (input.time)
        throw new Error("OpenCode v2 does not support legacy session archive updates.");
      const base = input.permission ?? permissions.rules.get(input.sessionID);
      const effective =
        base && !isPlanRules(base)
          ? [...base, ...(permissions.grants.get(input.sessionID) ?? [])]
          : base;
      await requestOpenCodeV2(
        http,
        sessionPath(input.sessionID),
        "PATCH",
        {
          title: input.title,
          metadata: input.metadata,
          permissions: openCodeV2PermissionRules(effective),
        },
        options?.signal,
        input.directory,
      );
      if (input.permission) permissions.rules.set(input.sessionID, input.permission);
      return { data: await read(input.sessionID, options?.signal, input.directory) };
    },
    promptAsync: sendPrompt,
    prompt: async (input, options) => {
      const before = new Set(
        (await messages(input.sessionID, options?.signal, input.directory)).map(
          (entry) => entry.info.id,
        ),
      );
      await sendPrompt(input, options);
      await requestOpenCodeV2(
        http,
        `/api/experimental/session/${encodeURIComponent(input.sessionID)}/wait`,
        "POST",
        undefined,
        options?.signal,
        input.directory,
        false,
        false,
      );
      const completed = await read(input.sessionID, options?.signal, input.directory);
      const outcome = completed.metadata?.opencodeOutcome;
      if (outcome === "failed" || outcome === "interrupted")
        throw new Error(`OpenCode v2 prompt ${outcome}.`);
      const response = (await messages(input.sessionID, options?.signal, input.directory))
        .filter((entry) => entry.info.role === "assistant" && !before.has(entry.info.id))
        .at(-1);
      if (!response || response.info.role !== "assistant")
        throw new Error("OpenCode v2 prompt completed without an assistant message.");
      if (response.info.error)
        throw new Error("OpenCode v2 prompt completed with an assistant error.");
      if (response.info.time.completed === undefined)
        throw new Error("OpenCode v2 prompt became idle before its assistant message completed.");
      return { data: { info: response.info, parts: response.parts } };
    },
    status: async (input, options) => {
      const active = openCodeV2Object(
        await requestOpenCodeV2(
          http,
          "/api/session/active",
          "GET",
          undefined,
          options?.signal,
          input?.directory,
        ),
      );
      const data: Record<string, { type: "busy" } | { type: "idle" }> = {};
      for (const id of knownSessions)
        data[id] = { type: Object.hasOwn(active, id) ? "busy" : "idle" };
      for (const id of Object.keys(active)) data[id] = { type: "busy" };
      return { data };
    },
    abort: async (input, options) => {
      await requestOpenCodeV2(
        http,
        sessionPath(input.sessionID, "/interrupt"),
        "POST",
        undefined,
        options?.signal,
        input.directory,
      );
      return { data: true };
    },
    messages: async (input, options) => {
      if (input.before)
        throw new Error(
          "OpenCode v2 message pagination uses opaque cursors; legacy before is unsupported.",
        );
      return {
        data: await messages(input.sessionID, options?.signal, input.directory, input.limit),
      };
    },
    children: async (input, options) => ({
      data: (
        await listOpenCodeV2Pages(
          http,
          `/api/session?parentID=${encodeURIComponent(input.sessionID)}`,
          options?.signal,
          input.directory,
        )
      ).map((session) => normalizeOpenCodeV2Session(session)),
    }),
    revert: async (input, options) => {
      if (input.partID) throw new Error("OpenCode v2 only supports reverting whole messages.");
      let messageID = input.messageID;
      if (!messageID)
        messageID = (await messages(input.sessionID, options?.signal, input.directory))[0]?.info.id;
      if (!messageID) throw new Error("OpenCode v2 cannot revert an empty session.");
      await requestOpenCodeV2(
        http,
        sessionPath(input.sessionID, "/revert/stage"),
        "POST",
        { messageID },
        options?.signal,
        input.directory,
      );
      await requestOpenCodeV2(
        http,
        sessionPath(input.sessionID, "/revert/commit"),
        "POST",
        undefined,
        options?.signal,
        input.directory,
      );
      return { data: await read(input.sessionID, options?.signal, input.directory) };
    },
    summarize: async (input, options) => {
      if (input.providerID && input.modelID)
        await requestOpenCodeV2(
          http,
          sessionPath(input.sessionID, "/model"),
          "POST",
          { model: { providerID: input.providerID, id: input.modelID } },
          options?.signal,
          input.directory,
        );
      await requestOpenCodeV2(
        http,
        sessionPath(input.sessionID, "/compact"),
        "POST",
        {},
        options?.signal,
        input.directory,
      );
      return { data: true };
    },
    fork: async (input, options) => ({
      data: normalizeOpenCodeV2Session(
        await requestOpenCodeV2(
          http,
          sessionPath(input.sessionID, "/fork"),
          "POST",
          { before: input.messageID },
          options?.signal,
          input.directory,
        ),
      ),
    }),
  };
}
