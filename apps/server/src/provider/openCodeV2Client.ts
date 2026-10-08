import {
  OpenCode,
  type FormInfo,
  type ModelRef,
  type SessionMessageInfo,
  type SessionPromptInput,
} from "@opencode/client";
import type { OpencodeClient, PermissionRuleset } from "@opencode-ai/sdk/v2";
import { detectOpenCodeProtocol } from "./openCodeProtocol.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  openCodeV2Agent,
  openCodeV2Answer,
  openCodeV2Inventory,
  openCodeV2Permission,
  openCodeV2Question,
  openCodeV2Rules,
  openCodeV2Session,
  isUnsupportedOpenCodeV2Form,
} from "./openCodeV2Mapping.ts";
import {
  createOpenCodeV2EventMapper,
  openCodeV2Message,
  type NormalizedOpenCodeEvent,
} from "./openCodeV2Messages.ts";

const result = <T>(data: T) => ({ data });

type RequestOptions = { readonly signal?: AbortSignal | null | undefined };
const requestOptions = (options?: RequestOptions) =>
  options?.signal ? { signal: options.signal } : {};
type PromptInput = NonNullable<Parameters<OpencodeClient["session"]["promptAsync"]>[0]>;
const nativeClients = new WeakMap<
  OpencodeClient,
  {
    readonly isV2: () => boolean;
    readonly credentials: () => Promise<string[]>;
    readonly outcome: (
      sessionID: string,
      signal: AbortSignal,
    ) => Promise<import("./openCodeV2Messages.ts").OpenCodeExecutionEvent | undefined>;
  }
>();

export function isOpenCodeV2Client(client: OpencodeClient): boolean {
  return nativeClients.get(client)?.isV2() === true;
}

export async function openCodeV2CredentialProviderIDs(
  client: OpencodeClient,
): Promise<string[] | undefined> {
  const state = nativeClients.get(client);
  return state?.isV2() ? state.credentials() : undefined;
}

export async function openCodeV2ExecutionOutcome(
  client: OpencodeClient,
  sessionID: string,
  signal: AbortSignal,
) {
  return nativeClients.get(client)?.isV2()
    ? nativeClients.get(client)?.outcome(sessionID, signal)
    : undefined;
}

/**
 * Keep Synara's existing adapter contract while calling the native V2 SDK.
 * The V1 SDK remains the fallback for V1 installations. No mutating request is
 * replayed to discover a protocol and no V2 operation uses a V1 HTTP route.
 */
export function withOpenCodeV2Client(
  legacy: OpencodeClient,
  input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly headers?: RequestInit["headers"];
    readonly fetch?: typeof globalThis.fetch;
  },
): OpencodeClient {
  const native = OpenCode.make(input);
  const location = { directory: input.directory };
  let protocol: "v1" | "v2" | undefined;
  const permissions = new Map<string, string>();
  const forms = new Map<string, FormInfo>();
  const submissions = new Map<string, number>();
  nativeClients.set(legacy, {
    isV2: () => protocol === "v2",
    credentials: async () => [
      ...new Set(
        (await native.model.list({ location })).data
          .filter((model) => model.enabled)
          .map((model) => model.providerID),
      ),
    ],
    outcome: async (sessionID, signal) => {
      const submitted = submissions.get(sessionID);
      if (submitted === undefined) return undefined;
      const session = await native.session.get({ sessionID }, { signal });
      if (session.outcome === undefined || (session.time.idle ?? 0) < submitted) return undefined;
      return {
        id: `${sessionID}:${session.time.idle}`,
        type: "synara.opencode.execution",
        properties: {
          sessionID,
          outcome: session.outcome,
          ...(session.outcome === "failed"
            ? { message: "OpenCode execution failed while the event stream was disconnected." }
            : {}),
        },
      };
    },
  });
  // Every bridged method keeps the V1 SDK response envelope. Its generic
  // throwOnError/responseStyle parameters are not part of Synara's usage.
  function route<F extends (...args: never[]) => unknown>(
    old: F,
    run: (...args: Parameters<F>) => Promise<unknown>,
  ): F {
    return (async (...args: Parameters<F>) => {
      const options = args[1] as RequestOptions | undefined;
      protocol ??= await detectOpenCodeProtocol({ ...input, signal: options?.signal ?? undefined });
      return protocol === "v2" ? run(...args) : old(...args);
    }) as F;
  }
  const rememberPermission = (request: Parameters<typeof openCodeV2Permission>[0]) => {
    permissions.set(request.id, request.sessionID);
    return openCodeV2Permission(request);
  };
  const rememberForm = (form: FormInfo) => {
    forms.set(form.id, form);
    return openCodeV2Question(form);
  };

  async function messages(sessionID: string, options?: RequestOptions) {
    const all: SessionMessageInfo[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await native.message.list(
        { sessionID, ...(cursor ? { cursor } : { order: "asc" }), limit: 200 },
        requestOptions(options),
      );
      all.push(...page.data);
      cursor = page.cursor.next ?? undefined;
      if (cursor && seen.has(cursor))
        throw new Error("OpenCode returned a repeated message cursor.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return all.flatMap((message) => {
      const mapped = openCodeV2Message(sessionID, message, input.directory);
      return mapped ? [mapped] : [];
    });
  }

  async function prompt(prompt: PromptInput, options?: RequestOptions) {
    const sessionID = prompt.sessionID;
    if (prompt.system)
      await native.session.instructions.entry.put(
        { sessionID, key: "synara", value: prompt.system },
        requestOptions(options),
      );
    if (prompt.agent)
      await native.session.switchAgent({ sessionID, agent: prompt.agent }, requestOptions(options));
    if (prompt.model)
      await native.session.switchModel(
        {
          sessionID,
          model: {
            providerID: prompt.model.providerID,
            id: prompt.model.modelID,
            ...(prompt.variant ? { variant: prompt.variant } : {}),
          },
        },
        requestOptions(options),
      );
    const files: NonNullable<SessionPromptInput["files"]>[number][] = [];
    for (const part of prompt.parts ?? []) {
      if (part.type !== "file") continue;
      files.push({ uri: part.url, ...(part.filename ? { name: part.filename } : {}) });
    }
    const text =
      prompt.parts?.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n") ?? "";
    const command = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (
      command?.[1] &&
      (await native.command.list({ location }, requestOptions(options))).data.some(
        (entry) => entry.name === command[1],
      )
    ) {
      const before = await native.session.get({ sessionID }, requestOptions(options));
      await native.session.command(
        { sessionID, name: command[1], text: command[2] ?? "", files, delivery: "steer" },
        requestOptions(options),
      );
      const created = before.time.updated + 1;
      submissions.set(sessionID, created);
      return { id: "", time: { created } };
    }
    const receipt = await native.session.prompt(
      {
        sessionID,
        ...(prompt.messageID ? { id: prompt.messageID } : {}),
        text,
        ...(files.length ? { files } : {}),
        agents: prompt.parts?.flatMap((part) =>
          part.type === "agent" ? [{ name: part.name }] : [],
        ),
        delivery: "steer",
      },
      requestOptions(options),
    );
    submissions.set(sessionID, receipt.time.created);
    return receipt;
  }

  legacy.provider.list = route(
    legacy.provider.list.bind(legacy.provider),
    async (_params, options) => {
      const [providers, models] = await Promise.all([
        native.provider.list({ location }, requestOptions(options)),
        native.model.list({ location }, requestOptions(options)),
      ]);
      return result(openCodeV2Inventory(providers.data, models.data));
    },
  );
  legacy.app.agents = route(legacy.app.agents.bind(legacy.app), async (_params, options) =>
    result(
      (await native.agent.list({ location }, requestOptions(options))).data.map(openCodeV2Agent),
    ),
  );
  legacy.command.list = route(legacy.command.list.bind(legacy.command), async (_params, options) =>
    result((await native.command.list({ location }, requestOptions(options))).data),
  );
  legacy.experimental.console.get = route(
    legacy.experimental.console.get.bind(legacy.experimental.console),
    async () => result(null),
  );
  legacy.path.get = route(legacy.path.get.bind(legacy.path), async (_params, options) => {
    const value = await native.location.get({ location }, requestOptions(options));
    return result({
      directory: value.directory,
      worktree: value.project.directory,
      home: "",
      state: "",
      config: "",
    });
  });
  legacy.global.health = route(legacy.global.health.bind(legacy.global), async (options) =>
    result({ healthy: true, version: (await native.server.info(requestOptions(options))).version }),
  );

  legacy.session.create = route(
    legacy.session.create.bind(legacy.session),
    async (params, options) => {
      // V1's SDK omits these fields from its types, although current V1 servers
      // and Synara's callers already pass them through to session.create.
      const creation = params as typeof params & { model?: ModelRef; agent?: string };
      return result(
        openCodeV2Session(
          await native.session.create(
            {
              location,
              title: creation?.title,
              parentID: creation?.parentID,
              model: creation?.model,
              agent: creation?.agent,
              ...(creation?.permission
                ? { permissions: openCodeV2Rules(creation.permission) }
                : {}),
            },
            requestOptions(options),
          ),
        ),
      );
    },
  );
  legacy.session.get = route(legacy.session.get.bind(legacy.session), async (params, options) =>
    result(
      openCodeV2Session(
        await native.session.get({ sessionID: params.sessionID }, requestOptions(options)),
      ),
    ),
  );
  legacy.session.update = route(
    legacy.session.update.bind(legacy.session),
    async (params, options) => {
      await native.session.update(
        {
          sessionID: params.sessionID,
          title: params.title,
          ...(params.permission
            ? { permissions: openCodeV2Rules(params.permission as PermissionRuleset) }
            : {}),
        },
        requestOptions(options),
      );
      return result(
        openCodeV2Session(
          await native.session.get({ sessionID: params.sessionID }, requestOptions(options)),
        ),
      );
    },
  );
  legacy.session.children = route(
    legacy.session.children.bind(legacy.session),
    async (params, options) => {
      const children = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await native.session.list(
          cursor ? { cursor } : { parentID: params.sessionID, limit: 100 },
          requestOptions(options),
        );
        children.push(...page.data.map(openCodeV2Session));
        cursor = page.cursor.next ?? undefined;
        if (cursor && seen.has(cursor))
          throw new Error("OpenCode returned a repeated session cursor.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return result(children);
    },
  );
  legacy.session.messages = route(
    legacy.session.messages.bind(legacy.session),
    async (params, options) => result(await messages(params.sessionID, requestOptions(options))),
  );
  legacy.session.status = route(
    legacy.session.status.bind(legacy.session),
    async (_params, options) =>
      result(
        Object.fromEntries(
          Object.keys(await native.session.active(requestOptions(options))).map((id) => [
            id,
            { type: "busy" },
          ]),
        ),
      ),
  );
  legacy.session.promptAsync = route(
    legacy.session.promptAsync.bind(legacy.session),
    async (params, options) => {
      await prompt(params, requestOptions(options));
      return result(undefined);
    },
  );
  legacy.session.prompt = route(
    legacy.session.prompt.bind(legacy.session),
    async (params, options) => {
      const receipt = await prompt(params, requestOptions(options));
      await native.session.wait({ sessionID: params.sessionID }, requestOptions(options));
      const session = await native.session.get(
        { sessionID: params.sessionID },
        requestOptions(options),
      );
      if (session.outcome !== "succeeded")
        throw new Error(`OpenCode execution ${session.outcome ?? "did not complete"}.`);
      const transcript = await messages(params.sessionID, requestOptions(options));
      const start = transcript.findIndex((entry) => entry.info.id === receipt.id);
      const reply = transcript
        .slice(start + 1)
        .findLast((entry) => entry.info.role === "assistant");
      if (!reply) throw new Error("OpenCode completed without an assistant response.");
      return result(reply);
    },
  );
  legacy.session.abort = route(
    legacy.session.abort.bind(legacy.session),
    async (params, options) => {
      await native.session.interrupt({ sessionID: params.sessionID }, requestOptions(options));
      return result(true);
    },
  );
  legacy.session.delete = route(
    legacy.session.delete.bind(legacy.session),
    async (params, options) => {
      await native.session.remove({ sessionID: params.sessionID }, requestOptions(options));
      return result(true);
    },
  );
  legacy.session.fork = route(legacy.session.fork.bind(legacy.session), async (params, options) =>
    result(
      openCodeV2Session(
        await native.session.fork(
          {
            sessionID: params.sessionID,
            ...(params.messageID ? { before: params.messageID } : {}),
          },
          requestOptions(options),
        ),
      ),
    ),
  );
  legacy.session.revert = route(
    legacy.session.revert.bind(legacy.session),
    async (params, options) => {
      const transcript = await messages(params.sessionID, requestOptions(options));
      // Synara passes the last retained assistant. Native V2 cuts before a user
      // message and must not restore files (Synara owns workspace checkpoints).
      const targetIndex = params.messageID
        ? transcript.findIndex((entry) => entry.info.id === params.messageID)
        : -1;
      if (params.messageID && targetIndex < 0)
        throw new Error("OpenCode rollback target is missing from the session history.");
      const after = transcript[targetIndex]?.info.role === "user" ? targetIndex : targetIndex + 1;
      const boundary = transcript.slice(after).find((entry) => entry.info.role === "user");
      if (!boundary)
        throw new Error("OpenCode rollback could not find the requested turn boundary.");
      try {
        await native.session.revert.stage(
          { sessionID: params.sessionID, messageID: boundary.info.id, files: false },
          requestOptions(options),
        );
        await native.session.revert.commit(
          { sessionID: params.sessionID },
          requestOptions(options),
        );
      } catch (cause) {
        // A failed commit must not leave a staged cut for the next prompt to
        // commit implicitly. Cleanup has its own bounded cancellation signal.
        await native.session.revert
          .clear({ sessionID: params.sessionID }, { signal: AbortSignal.timeout(3_000) })
          .catch(() => {});
        throw cause;
      }
      return result(
        openCodeV2Session(
          await native.session.get({ sessionID: params.sessionID }, requestOptions(options)),
        ),
      );
    },
  );
  legacy.session.summarize = route(
    legacy.session.summarize.bind(legacy.session),
    async (params, options) => {
      await native.session.compact({ sessionID: params.sessionID }, requestOptions(options));
      return result(true);
    },
  );
  legacy.mcp.add = route(legacy.mcp.add.bind(legacy.mcp), async (params, options) => {
    if (!params?.name || !params.config)
      throw new Error("OpenCode MCP registration requires a name and configuration.");
    const { enabled, timeout, ...config } = params.config;
    await native.mcp.add(
      {
        server: params.name,
        location,
        config: {
          ...config,
          disabled: enabled === false,
          ...(timeout !== undefined ? { timeout: { catalog: timeout, execution: timeout } } : {}),
        },
      },
      requestOptions(options),
    );
    // PUT accepts the configuration before the MCP handshake finishes. Wait
    // for a terminal connection state before reporting gateway readiness.
    const signal = options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(9_000)])
      : AbortSignal.timeout(9_000);
    while (true) {
      const servers = (await native.mcp.list({ location }, { signal })).data;
      const status = servers.find((server) => server.name === params.name)?.status.status;
      if (status !== undefined && status !== "pending") {
        // OpenCode 2.0.25 publishes connected before McpTool's 100ms
        // debounced registry reload. There is no catalog-ready API yet.
        // Give that reload a settling window before the first prompt;
        // otherwise Code Mode search can return an empty Synara catalog.
        if (status === "connected") await delay(200, undefined, { signal });
        return result(Object.fromEntries(servers.map((server) => [server.name, server.status])));
      }
      await delay(100, undefined, { signal });
    }
  });
  legacy.permission.list = route(
    legacy.permission.list.bind(legacy.permission),
    async (_params, options) => {
      const requests = (await native.permission.request.list({ location }, requestOptions(options)))
        .data;
      return result(requests.map(rememberPermission));
    },
  );
  legacy.permission.reply = route(
    legacy.permission.reply.bind(legacy.permission),
    async (params, options) => {
      const sessionID = permissions.get(params.requestID);
      if (!sessionID)
        throw new Error("OpenCode permission is no longer pending; refresh the session.");
      await native.permission.reply(
        { sessionID, requestID: params.requestID, decision: params.reply ?? "reject" },
        requestOptions(options),
      );
      permissions.delete(params.requestID);
      return result(true);
    },
  );
  legacy.question.list = route(
    legacy.question.list.bind(legacy.question),
    async (_params, options) => {
      const pending = (await native.form.list({ location }, requestOptions(options))).data;
      return result(pending.map(rememberForm));
    },
  );
  legacy.question.reply = route(
    legacy.question.reply.bind(legacy.question),
    async (params, options) => {
      const form = forms.get(params.requestID);
      if (!form) throw new Error("OpenCode form is no longer pending; refresh the session.");
      if (isUnsupportedOpenCodeV2Form(form)) {
        if (params.answers?.[0]?.[0] !== "Cancel")
          throw new Error("Complete this form in OpenCode, or select Cancel.");
        await native.session.form.cancel(
          { sessionID: form.sessionID, formID: form.id },
          requestOptions(options),
        );
        forms.delete(form.id);
        return result(true);
      }
      await native.session.form.reply(
        {
          sessionID: form.sessionID,
          formID: form.id,
          answer: openCodeV2Answer(form, params.answers ?? []),
        },
        requestOptions(options),
      );
      // Keep the field order and option labels until form.replied is mapped;
      // the HTTP reply can finish before its SSE acknowledgement arrives.
      return result(true);
    },
  );
  legacy.question.reject = route(
    legacy.question.reject.bind(legacy.question),
    async (params, options) => {
      const form = forms.get(params.requestID);
      if (!form) throw new Error("OpenCode form is no longer pending; refresh the session.");
      await native.session.form.cancel(
        { sessionID: form.sessionID, formID: form.id },
        requestOptions(options),
      );
      forms.delete(form.id);
      return result(true);
    },
  );
  legacy.event.subscribe = route(
    legacy.event.subscribe.bind(legacy.event),
    async (_params, options) => {
      const controller = new AbortController();
      const signal = options?.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
      let timer: ReturnType<typeof setTimeout>;
      const activity = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => controller.abort(new Error("OpenCode event stream timed out.")),
          45_000,
        );
        timer.unref();
      };
      activity();
      const events = native.event.subscribe({ signal, onActivity: activity });
      const iterator = events[Symbol.asyncIterator]();
      const mapper = createOpenCodeV2EventMapper(input.directory, (id) => forms.get(id));
      // The first server.connected frame proves subscription before prompt admission.
      let first: IteratorResult<Parameters<typeof mapper>[0]>;
      try {
        first = await iterator.next();
      } catch (cause) {
        clearTimeout(timer!);
        controller.abort();
        throw cause;
      }
      async function* stream(): AsyncGenerator<NormalizedOpenCodeEvent> {
        try {
          let next = first;
          while (!next.done) {
            const event = next.value;
            if (event.type === "session.execution.started")
              submissions.set(event.data.sessionID, event.created);
            if (event.type === "permission.asked") rememberPermission(event.data);
            if (event.type === "form.created") rememberForm(event.data.form);
            yield* mapper(event);
            if (event.type === "permission.replied") permissions.delete(event.data.requestID);
            if (event.type === "form.replied" || event.type === "form.cancelled")
              forms.delete(event.data.id);
            next = await iterator.next();
          }
        } finally {
          clearTimeout(timer!);
          controller.abort();
          await iterator.return?.();
        }
      }
      return { stream: stream() };
    },
  );
  return legacy;
}
