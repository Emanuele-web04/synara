import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { FormInfo } from "@opencode/client";
import { describe, expect, it } from "vitest";
import { withOpenCodeV2Client, openCodeV2ExecutionOutcome } from "./openCodeV2Client.ts";
import type { NormalizedOpenCodeEvent } from "./openCodeV2Messages.ts";

const json = (data: unknown) => Response.json(data);
const directory = "/workspace/project";
const tokens = { input: 10, output: 4, reasoning: 1, cache: { read: 2, write: 0 } };
const session = {
  id: "ses_root",
  projectID: "project",
  location: { directory },
  title: "Task",
  time: { created: 1, updated: 2 },
  cost: 0,
  tokens,
};
const form: FormInfo = {
  id: "frm_choice",
  sessionID: "ses_child",
  title: "Choose",
  fields: [
    {
      type: "string",
      key: "choice",
      title: "Choice",
      required: true,
      options: [{ value: "internal", label: "Visible" }],
    },
    { type: "boolean", key: "confirm", title: "Confirm" },
  ],
};
const permission = {
  id: "per_read",
  sessionID: "ses_child",
  action: "shell",
  resources: ["git status"],
  save: ["git *"],
  source: { type: "tool", messageID: "msg_step", id: "call_shell" },
};

function fixture() {
  const calls: Array<{ path: string; method: string; body: Record<string, unknown>; url: URL }> =
    [];
  let events: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamClosed = false;
  let outcome: "succeeded" | "failed" | "interrupted" | undefined;
  let authStatus = 200;
  let protocol: "v1" | "v2" = "v2";
  let repeatedCursor = false;
  let pendingForm: FormInfo = form;
  let failRevertCommit = false;
  let pendingMcp = false;
  let mcpReads = 0;
  const emit = (type: string, data: unknown = {}) =>
    events!.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ id: `evt_${calls.length}`, created: 20, type, data })}\n\n`,
      ),
    );
  const fetchImpl: typeof fetch = Object.assign(
    async (resource: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request =
        typeof resource === "string"
          ? new Request(resource, init)
          : resource instanceof URL
            ? new Request(resource.href, init)
            : new Request(resource, init);
      const url = new URL(request.url);
      const body =
        request.method === "GET"
          ? {}
          : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
      calls.push({ path: url.pathname, method: request.method, body, url });
      const data = (value: unknown) => json({ data: value });
      if (url.pathname === "/api/info")
        return authStatus !== 200
          ? new Response(null, { status: authStatus })
          : protocol === "v1"
            ? new Response("<html>OpenCode</html>", { headers: { "content-type": "text/html" } })
            : json({ version: "2.0.25", pid: 10, urls: [], paths: { tmp: "/tmp" } });
      if (protocol === "v1") {
        if (url.pathname === "/session" && request.method === "POST")
          return json({ ...session, directory });
        throw new Error(`Unexpected V1 request: ${request.method} ${url.pathname}`);
      }
      if (!url.pathname.startsWith("/api/"))
        return new Response("legacy API removed", { status: 405 });
      if (url.pathname === "/api/session" && request.method === "POST") return data(session);
      if (url.pathname === "/api/session" && request.method === "GET")
        return json({ data: [{ ...session, id: "ses_child", parentID: session.id }], cursor: {} });
      if (url.pathname === "/api/session/active") return json({});
      if (url.pathname === "/api/session/ses_root" && request.method === "GET")
        return data({
          ...session,
          ...(outcome ? { outcome, time: { ...session.time, idle: 30 } } : {}),
        });
      if (url.pathname === "/api/session/ses_root/message") {
        if (!url.searchParams.has("cursor"))
          return json({
            data: [{ id: "msg_user", type: "user", time: { created: 10 }, text: "Hello" }],
            cursor: { next: "page2" },
          });
        return json({
          data: [
            {
              id: "msg_reply",
              type: "assistant",
              time: { created: 11, completed: 12 },
              agent: "build",
              model: { providerID: "local", id: "model" },
              content: [{ type: "text", text: "Hello back" }],
              finish: "stop",
              tokens,
            },
          ],
          cursor: repeatedCursor ? { next: "page2" } : {},
        });
      }
      if (url.pathname === "/api/session/ses_root/prompt")
        return data({
          id: "msg_user",
          sessionID: session.id,
          type: "user",
          time: { created: 10 },
          payload: body,
          delivery: "steer",
        });
      if (url.pathname === "/api/session/ses_root/fork")
        return data({ ...session, id: "ses_fork" });
      if (url.pathname === "/api/session/ses_root/revert/stage")
        return data({ messageID: body.messageID });
      if (url.pathname === "/api/permission/request")
        return json({ location: { directory }, data: [permission] });
      if (url.pathname === "/api/form")
        return json({ location: { directory }, data: [pendingForm] });
      if (url.pathname === "/api/session/ses_root/revert/commit" && failRevertCommit)
        return new Response(null, { status: 503 });
      if (url.pathname === "/api/mcp")
        return json({
          location: { directory },
          data: [
            {
              name: "synara",
              status: pendingMcp
                ? { status: mcpReads++ === 0 ? "pending" : "connected" }
                : { status: "failed", error: "Unauthorized gateway" },
            },
          ],
        });
      if (url.pathname === "/api/provider")
        return json({
          location: { directory },
          data: [{ id: "local", name: "Local", activation: "enabled", package: "test" }],
        });
      if (url.pathname === "/api/command")
        return json({
          location: { directory },
          data: [{ name: "review", template: "Review $ARGUMENTS" }],
        });
      if (url.pathname === "/api/model")
        return json({
          location: { directory },
          data: [
            {
              id: "model",
              modelID: "api-model",
              providerID: "local",
              name: "Model",
              enabled: true,
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
              limit: { context: 1000, output: 100 },
            },
          ],
        });
      if (url.pathname === "/api/event")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              events = controller;
              emit("server.connected");
              request.signal.addEventListener(
                "abort",
                () => {
                  streamClosed = true;
                  controller.close();
                },
                { once: true },
              );
            },
            cancel() {
              streamClosed = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      if (request.method !== "GET") return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );
  const base = {
    baseUrl: "http://opencode.test",
    directory,
    fetch: fetchImpl,
    throwOnError: true as const,
  };
  return {
    client: withOpenCodeV2Client(createOpencodeClient(base), base),
    calls,
    emit,
    get closed() {
      return streamClosed;
    },
    set outcome(value: typeof outcome) {
      outcome = value;
    },
    set authStatus(value: number) {
      authStatus = value;
    },
    set protocol(value: typeof protocol) {
      protocol = value;
    },
    set repeatedCursor(value: boolean) {
      repeatedCursor = value;
    },
    set pendingForm(value: FormInfo) {
      pendingForm = value;
    },
    set failRevertCommit(value: boolean) {
      failRevertCommit = value;
    },
    set pendingMcp(value: boolean) {
      pendingMcp = value;
    },
    legacy: createOpencodeClient(base),
  };
}

describe("OpenCode V2 client boundary", () => {
  it("executes discovered slash commands natively while keeping harness instructions separate", async () => {
    const server = fixture();
    await server.client.session.promptAsync({
      sessionID: session.id,
      system: "Synara host instructions",
      parts: [{ type: "text", text: "/review changed files" }],
    });
    const command = server.calls.find((call) => call.path === "/api/session/ses_root/command");
    expect(command?.body).toMatchObject({
      name: "review",
      text: "changed files",
      delivery: "steer",
    });
    expect(server.calls.some((call) => call.path.endsWith("/prompt"))).toBe(false);
    expect(
      server.calls.find((call) => call.path.endsWith("/instructions/entries/synara"))?.body,
    ).toEqual({ value: "Synara host instructions" });
  });
  it("waits for an asynchronous MCP handshake before admitting work", async () => {
    const server = fixture();
    server.pendingMcp = true;
    const result = await server.client.mcp.add({
      name: "synara",
      config: { type: "remote", url: "http://gateway.test/mcp", enabled: true, oauth: false },
    });
    expect(result.data?.synara?.status).toBe("connected");
    expect(server.calls.filter((call) => call.path === "/api/mcp")).toHaveLength(2);
  });
  it("rejects the old client's V1 mutation against the same native server fixture", async () => {
    const server = fixture();
    await expect(server.legacy.session.create({ title: "Legacy" })).rejects.toBeDefined();
    expect(server.calls.map((call) => call.path)).toEqual(["/session"]);
    expect((await server.client.session.create({ title: "Native" })).data?.id).toBe(session.id);
  });

  it("commits rollback at a user boundary and clears staging after a failed commit", async () => {
    const server = fixture();
    await server.client.session.revert({ sessionID: session.id, messageID: "msg_user" });
    const mutations = server.calls.filter((call) => call.method !== "GET");
    expect(mutations.map((call) => call.path)).toEqual([
      "/api/session/ses_root/revert/stage",
      "/api/session/ses_root/revert/commit",
    ]);
    expect(mutations[0]?.body).toEqual({ messageID: "msg_user", files: false });
    await expect(
      server.client.session.revert({ sessionID: session.id, messageID: "missing" }),
    ).rejects.toThrow("target is missing");
    server.failRevertCommit = true;
    await expect(server.client.session.revert({ sessionID: session.id })).rejects.toThrow();
    expect(server.calls.at(-1)?.path).toBe("/api/session/ses_root/revert");
    expect(server.calls.at(-1)?.method).toBe("DELETE");
  });

  it("keeps unsupported native forms pending until the user explicitly cancels", async () => {
    const server = fixture();
    server.pendingForm = { ...form, fields: [{ type: "string", key: "hidden", hidden: true }] };
    const request = (await server.client.question.list()).data?.[0];
    expect(request?.questions[0]?.options[0]?.label).toBe("Cancel");
    expect(server.calls.every((call) => call.method === "GET")).toBe(true);
    await expect(
      server.client.question.reply({ requestID: form.id, answers: [["yes"]] }),
    ).rejects.toThrow("Complete this form");
    await server.client.question.reject({ requestID: form.id });
    expect(server.calls.at(-1)?.path).toBe("/api/session/ses_child/form/frm_choice");
  });
  it("uses native session, permission, form, and MCP contracts without replaying legacy mutations", async () => {
    const server = fixture();
    const { client, calls } = server;
    await client.session.create({
      permission: [{ permission: "bash", pattern: "git *", action: "ask" }],
      title: "Task",
    });
    expect(calls.find((call) => call.path === "/api/session")?.body).toMatchObject({
      location: { directory },
      permissions: [{ action: "shell", resource: "git *", effect: "ask" }],
    });
    const inventory = (await client.provider.list()).data!;
    expect(inventory.connected).toEqual(["local"]);
    expect(inventory.all[0]?.models.model?.id).toBe("model");
    await client.session.promptAsync({
      sessionID: session.id,
      agent: "plan",
      model: { providerID: "local", modelID: "model" },
      variant: "high",
      parts: [
        { type: "text", text: "Hello" },
        { type: "file", mime: "image/png", url: "data:image/png;base64,aGVsbG8=" },
      ],
    });
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      "/api/session",
      "/api/session/ses_root/agent",
      "/api/session/ses_root/model",
      "/api/session/ses_root/prompt",
    ]);
    expect(calls.at(-1)?.body).toMatchObject({
      text: "Hello",
      delivery: "steer",
      files: [{ uri: "data:image/png;base64,aGVsbG8=" }],
    });
    expect((await client.permission.list()).data?.[0]).toMatchObject({
      sessionID: "ses_child",
      permission: "bash",
      patterns: ["git status"],
    });
    await client.permission.reply({ requestID: permission.id, reply: "once" });
    expect(calls.at(-1)).toMatchObject({
      path: "/api/session/ses_child/permission/per_read/reply",
      body: { decision: "once" },
    });
    const question = (await client.question.list()).data?.[0];
    expect(question?.questions[0]?.options[0]?.label).toBe("Visible");
    await client.question.reply({ requestID: form.id, answers: [["Visible"], ["true"]] });
    expect(calls.at(-1)).toMatchObject({
      path: "/api/session/ses_child/form/frm_choice/reply",
      body: { answer: { choice: "internal", confirm: true } },
    });
    const mcp = await client.mcp.add({
      name: "synara",
      config: {
        type: "remote",
        url: "http://gateway.test/mcp",
        headers: { Authorization: "Bearer scoped" },
        oauth: false,
        enabled: true,
        timeout: 1000,
      },
    });
    expect(mcp.data?.synara).toEqual({ status: "failed", error: "Unauthorized gateway" });
    const registration = calls.find((call) => call.path === "/api/experimental/mcp/synara")!;
    expect(registration.method).toBe("PUT");
    expect(registration.url.searchParams.get("location[directory]")).toBe(directory);
    expect(registration.body).toMatchObject({
      config: {
        disabled: false,
        headers: { Authorization: "Bearer scoped" },
        timeout: { catalog: 1000, execution: 1000 },
      },
    });
    expect(calls.every((call) => call.path.startsWith("/api/"))).toBe(true);
  });

  it("paginates recovery, keeps snapshot IDs stable, and recovers a lost failed terminal", async () => {
    const server = fixture();
    await server.client.session.promptAsync({
      sessionID: session.id,
      parts: [{ type: "text", text: "Hello" }],
    });
    const recovered = (await server.client.session.messages({ sessionID: session.id })).data!;
    expect(recovered.map((entry) => entry.info.id)).toEqual(["msg_user", "msg_reply"]);
    expect(recovered[1]?.parts[0]).toMatchObject({ id: "msg_reply:part:0", text: "Hello back" });
    expect(server.calls.at(-1)?.url.searchParams.has("order")).toBe(false);
    server.outcome = "failed";
    expect(
      await openCodeV2ExecutionOutcome(server.client, session.id, new AbortController().signal),
    ).toMatchObject({ properties: { outcome: "failed", sessionID: session.id } });
    server.repeatedCursor = true;
    await expect(server.client.session.messages({ sessionID: session.id })).rejects.toThrow(
      "repeated message cursor",
    );
  });

  it("subscribes before work, preserves per-step text and tool IDs, and closes an aborted SSE reader", async () => {
    const server = fixture();
    const abort = new AbortController();
    const subscription = await server.client.event.subscribe(undefined, { signal: abort.signal });
    const received: NormalizedOpenCodeEvent[] = [];
    const collect = (async () => {
      for await (const event of subscription.stream) received.push(event);
    })();
    server.emit("session.step.started", {
      sessionID: session.id,
      assistantMessageID: "msg_reply",
      agent: "build",
      model: { providerID: "local", id: "model" },
      started: 10,
    });
    server.emit("session.text.started", {
      sessionID: session.id,
      assistantMessageID: "msg_reply",
      ordinal: 0,
    });
    server.emit("session.text.delta", {
      sessionID: session.id,
      assistantMessageID: "msg_reply",
      ordinal: 0,
      delta: "Hello",
    });
    server.emit("session.text.ended", {
      sessionID: session.id,
      assistantMessageID: "msg_reply",
      ordinal: 0,
      text: "Hello back",
    });
    server.emit("session.tool.input.started", {
      sessionID: session.id,
      assistantMessageID: "msg_reply",
      id: "call_shell",
      name: "shell",
    });
    server.emit("session.tool.called", {
      sessionID: session.id,
      assistantMessageID: "msg_reply",
      id: "call_shell",
      input: { command: "git status" },
      executed: true,
    });
    server.emit("session.tool.success", {
      sessionID: session.id,
      assistantMessageID: "msg_reply",
      id: "call_shell",
      content: [{ type: "text", text: "clean" }],
      executed: true,
    });
    server.emit("session.step.ended", {
      sessionID: session.id,
      assistantMessageID: "msg_reply",
      finish: "tool-calls",
      tokens,
      cost: 0.01,
    });
    server.emit("session.execution.interrupted", { sessionID: session.id, reason: "user" });
    await expect
      .poll(() => received.some((event) => event.type === "synara.opencode.execution"))
      .toBe(true);
    const parts = received.flatMap((event) =>
      event.type === "message.part.updated" ? [event.properties.part] : [],
    );
    expect(parts).toContainEqual(
      expect.objectContaining({ id: "msg_reply:part:0", text: "Hello back" }),
    );
    expect(parts).toContainEqual(
      expect.objectContaining({
        id: "msg_reply:tool:call_shell",
        tool: "bash",
        state: expect.objectContaining({ status: "completed", output: "clean" }),
      }),
    );
    expect(received.filter((event) => event.type === "synara.opencode.execution")).toEqual([
      expect.objectContaining({ properties: { sessionID: session.id, outcome: "interrupted" } }),
    ]);
    abort.abort();
    await collect;
    expect(server.closed).toBe(true);
  });

  it("preserves displayed answers when the native form acknowledgement follows the HTTP reply", async () => {
    const server = fixture();
    const abort = new AbortController();
    const subscription = await server.client.event.subscribe(undefined, { signal: abort.signal });
    const received: NormalizedOpenCodeEvent[] = [];
    const collect = (async () => {
      for await (const event of subscription.stream) received.push(event);
    })();
    await server.client.question.list();
    await server.client.question.reply({ requestID: form.id, answers: [["Visible"], ["true"]] });
    server.emit("form.replied", {
      id: form.id,
      sessionID: form.sessionID,
      answer: { choice: "internal", confirm: true },
    });
    await expect
      .poll(() => received.find((event) => event.type === "question.replied"))
      .toMatchObject({
        properties: { requestID: form.id, answers: [["Visible"], ["true"]] },
      });
    abort.abort();
    await collect;
  });

  it("preserves V1 requests and does not fall back after V2 authentication rejection", async () => {
    const old = fixture();
    old.protocol = "v1";
    expect((await old.client.session.create({ title: "V1" })).data?.id).toBe(session.id);
    expect(old.calls.map((call) => call.path)).toEqual(["/api/info", "/session"]);
    const denied = fixture();
    denied.authStatus = 401;
    await expect(denied.client.session.create({ title: "Denied" })).rejects.toThrow(
      "server password",
    );
    expect(denied.calls.map((call) => call.path)).toEqual(["/api/info"]);
  });
});
