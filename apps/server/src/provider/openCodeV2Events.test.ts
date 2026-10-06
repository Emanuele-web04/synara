import { describe, expect, it, vi } from "vitest";
import { createOpenCodeV2EventNormalizer } from "./openCodeV2EventNormalization";
import { subscribeOpenCodeV2Events } from "./openCodeV2Events";
import type { OpenCodeV2Fetch } from "./openCodeV2TransportHttp.ts";

const frame = (type: string, data: Record<string, unknown> = {}) => ({
  type,
  data: { sessionID: "s", assistantMessageID: "m", ...data },
});
const encode = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const collect = async <T>(stream: AsyncIterable<T>) => {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
};
const response = (text: string, split = 1) => {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += split)
          controller.enqueue(bytes.slice(index, index + split));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};
const fetchResponse = (value: Response) => vi.fn<OpenCodeV2Fetch>().mockResolvedValue(value);

describe("OpenCode v2 event stream", () => {
  it("retains an external reverse-proxy path and refuses redirects", async () => {
    const fetchImpl = fetchResponse(response(encode(frame("session.execution.started"))));
    const { stream } = await subscribeOpenCodeV2Events({
      baseUrl: "http://localhost/proxy/",
      fetchImpl,
    });
    await collect(stream);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://localhost/proxy/api/event");
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("keeps shutdown interruption resumable and surfaces unsupported forms without disconnecting", () => {
    const normalize = createOpenCodeV2EventNormalizer();
    expect(normalize(frame("session.execution.interrupted", { reason: "shutdown" }))).toEqual([]);
    expect(
      normalize(
        frame("form.created", {
          form: {
            id: "frm-1",
            sessionID: "s",
            fields: [{ key: "upload", type: "external", url: "https://example.com" }],
          },
        }),
      ),
    ).toMatchObject([
      { type: "question.unsupported", properties: { sessionID: "s", requestID: "frm-1" } },
    ]);
    expect(
      normalize(frame("permission.replied", { id: "perm-1", decision: "once" })),
    ).toMatchObject([
      { type: "permission.replied", properties: { requestID: "perm-1", reply: "once" } },
    ]);
  });

  it("handles UTF-8 byte boundaries, CRLF, comments and multiline data", async () => {
    const payload = JSON.stringify(frame("session.text.delta", { delta: "hey 🦝", ordinal: 2 }));
    const cut = payload.indexOf('"data"');
    const fetchImpl = fetchResponse(
      response(
        `: heartbeat\r\nevent: message\r\ndata: ${payload.slice(0, cut)}\r\ndata: ${payload.slice(cut)}\r\n\r\n`,
      ),
    );
    const { stream } = await subscribeOpenCodeV2Events({
      baseUrl: "http://localhost:99",
      headers: { authorization: "Basic test", "x-opencode-directory": "/repo" },
      fetchImpl,
    });
    const events = await collect(stream);
    expect(events).toEqual([
      {
        type: "message.part.delta",
        properties: {
          sessionID: "s",
          messageID: "m",
          partID: "m:t2",
          field: "text",
          delta: "hey 🦝",
        },
      },
    ]);
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:99/api/event");
    expect(new Headers(options?.headers).get("accept")).toBe("text/event-stream");
    expect(new Headers(options?.headers).get("authorization")).toBe("Basic test");
    expect(new Headers(options?.headers).get("x-opencode-directory")).toBe("/repo");
  });

  it("decodes the API's JSON-string event encoding", async () => {
    const { stream } = await subscribeOpenCodeV2Events({
      baseUrl: "http://localhost",
      fetchImpl: fetchResponse(
        response(encode(JSON.stringify(frame("session.execution.started")))),
      ),
    });
    expect(await collect(stream)).toEqual([
      { type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } },
    ]);
  });

  it("cancels and releases the body when a consumer stops", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(encode(frame("session.execution.started"))));
      },
      cancel,
    });
    const { stream } = await subscribeOpenCodeV2Events({
      baseUrl: "http://localhost",
      fetchImpl: fetchResponse(new Response(body)),
    });
    for await (const _ of stream) break;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("cancels even when return precedes the first read", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { stream } = await subscribeOpenCodeV2Events({
      baseUrl: "http://localhost",
      fetchImpl: fetchResponse(new Response(body)),
    });
    await stream[Symbol.asyncIterator]().return?.();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("unblocks a pending read when aborted", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { stream } = await subscribeOpenCodeV2Events({
      baseUrl: "http://localhost",
      signal: controller.signal,
      fetchImpl: fetchResponse(new Response(body)),
    });
    const read = stream[Symbol.asyncIterator]().next();
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("propagates HTTP errors without a retry", async () => {
    const fetchImpl = fetchResponse(new Response("unauthorized", { status: 401 }));
    await expect(
      subscribeOpenCodeV2Events({ baseUrl: "http://localhost", fetchImpl }),
    ).rejects.toThrow("HTTP 401");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails malformed frames and discards incomplete frames at disconnect", async () => {
    const first = await subscribeOpenCodeV2Events({
      baseUrl: "http://localhost",
      fetchImpl: fetchResponse(response("data: nope\n\n")),
    });
    await expect(collect(first.stream)).rejects.toThrow("invalid JSON");
    const second = await subscribeOpenCodeV2Events({
      baseUrl: "http://localhost",
      fetchImpl: fetchResponse(response(encode(frame("session.execution.started")).trimEnd())),
    });
    expect(await collect(second.stream)).toEqual([]);
  });

  it("bounds the entire data framing even when each value is empty", async () => {
    const { stream } = await subscribeOpenCodeV2Events({
      baseUrl: "http://localhost",
      fetchImpl: fetchResponse(response("data:\n".repeat(Math.ceil((8 * 1024 * 1024) / 6)), 65536)),
    });
    await expect(collect(stream)).rejects.toThrow("frame is too large");
  });

  it("retains tool names and inputs across reconnect subscriptions", async () => {
    const normalize = createOpenCodeV2EventNormalizer();
    const subscribe = async (frames: unknown[]) =>
      subscribeOpenCodeV2Events({
        baseUrl: "http://localhost",
        normalize,
        fetchImpl: fetchResponse(response(frames.map(encode).join(""))),
      });
    const first = await subscribe([
      frame("session.tool.input.started", { id: "call", name: "shell" }),
      frame("session.tool.called", { id: "call", input: { command: "pwd" } }),
    ]);
    await collect(first.stream);
    const second = await subscribe([
      frame("session.tool.success", { id: "call", content: [{ type: "text", text: "/repo" }] }),
    ]);
    expect(await collect(second.stream)).toMatchObject([
      {
        type: "message.part.updated",
        properties: {
          part: {
            tool: "shell",
            state: { status: "completed", input: { command: "pwd" }, output: "/repo" },
          },
        },
      },
    ]);
  });
});

describe("OpenCode v2 event normalization", () => {
  it("routes nested interactive forms and resolves answers using original keys", () => {
    const normalize = createOpenCodeV2EventNormalizer();
    const form = {
      id: "frm_test",
      sessionID: "child",
      title: "Confirm",
      fields: [
        {
          key: "color",
          type: "string",
          title: "Color",
          custom: false,
          options: [{ label: "Blue", value: "b" }],
        },
        { key: "ready", type: "boolean", title: "Ready" },
      ],
    };
    expect(normalize({ type: "form.created", data: { form } })[0]).toMatchObject({
      type: "question.asked",
      properties: {
        id: "frm_test",
        sessionID: "child",
        questions: [{ question: "Color" }, { question: "Ready" }],
      },
    });
    expect(
      normalize({
        type: "form.replied",
        data: { sessionID: "child", id: "frm_test", answer: { ready: true, color: "b" } },
      }),
    ).toEqual([
      {
        type: "question.replied",
        properties: { sessionID: "child", requestID: "frm_test", answers: [["Blue"], ["Yes"]] },
      },
    ]);
    expect(
      normalize({ type: "form.cancelled", data: { sessionID: "child", id: "frm_test" } }),
    ).toEqual([
      { type: "question.rejected", properties: { sessionID: "child", requestID: "frm_test" } },
    ]);
  });

  it("preserves explicit approval details and provider tool call identity", () => {
    const normalize = createOpenCodeV2EventNormalizer();
    expect(
      normalize(
        frame("permission.asked", {
          id: "p",
          action: "read",
          resources: ["/secret"],
          save: [],
          source: { type: "tool", messageID: "m", id: "call" },
        }),
      )[0],
    ).toMatchObject({
      type: "permission.asked",
      properties: {
        id: "p",
        sessionID: "s",
        permission: "read",
        patterns: ["/secret"],
        always: [],
        tool: { messageID: "m", callID: "call" },
      },
    });
    expect(
      normalize(frame("permission.replied", { requestID: "p", reply: "reject" }))[0],
    ).toMatchObject({
      type: "permission.replied",
      properties: { requestID: "p", reply: "reject" },
    });
  });

  it("takes time from the v2 envelope and distinguishes failed shell commands", () => {
    const normalize = createOpenCodeV2EventNormalizer();
    expect(
      normalize({ ...frame("session.text.ended", { text: "done", ordinal: 0 }), created: 123 })[0],
    ).toMatchObject({ properties: { part: { time: { end: 123 } } } });
    const shell = { id: "sh_test", command: "ls", status: "running", time: { started: 100 } };
    expect(normalize(frame("session.shell.started", { shell }))[0]).toMatchObject({
      type: "session.next.shell.started",
      properties: { sessionID: "s", callID: "sh_test", command: "ls", timestamp: 100 },
    });
    expect(
      normalize(
        frame("session.shell.ended", {
          shell: { ...shell, status: "exited", exit: 0 },
          output: { output: "file" },
        }),
      )[0],
    ).toMatchObject({ type: "session.next.shell.ended", properties: { output: "file" } });
    expect(
      normalize(frame("session.shell.ended", { shell: { ...shell, status: "timeout" } }))[0],
    ).toMatchObject({
      type: "session.next.tool.failed",
      properties: { error: { message: "Shell command timeout." } },
    });
    expect(normalize(frame("session.created", { title: "child" }))).toEqual([]);
  });

  it("distinguishes terminal success, failure and interruption", () => {
    const normalize = createOpenCodeV2EventNormalizer();
    expect(normalize(frame("session.execution.succeeded"))[0]?.type).toBe("session.idle");
    expect(normalize(frame("session.execution.interrupted"))[0]?.type).toBe("session.interrupted");
    expect(
      normalize(
        frame("session.execution.failed", { error: { type: "provider.auth", message: "" } }),
      ),
    ).toEqual([
      {
        type: "session.error",
        properties: {
          sessionID: "s",
          error: { name: "provider.auth", data: { message: "provider.auth" } },
        },
      },
    ]);
    expect(
      normalize(
        frame("session.step.failed", {
          error: { type: "provider.rate-limit", message: "Retrying" },
        }),
      )[0]?.type,
    ).toBe("session.warning");
    expect(normalize(frame("session.step.failed", { error: { type: "aborted" } }))).toEqual([]);
  });

  it("keeps step usage separate from terminal completion and ignores cumulative usage", () => {
    const normalize = createOpenCodeV2EventNormalizer();
    normalize(frame("session.step.started", { model: { id: "model", providerID: "provider" } }));
    const events = normalize(
      frame("session.step.ended", { finish: "stop", cost: 0.25, tokens: { input: 12, output: 3 } }),
    );
    expect(events).toEqual([
      {
        type: "message.updated",
        properties: {
          sessionID: "s",
          info: {
            sessionID: "s",
            id: "m",
            role: "assistant",
            cost: 0.25,
            tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "model",
            providerID: "provider",
          },
        },
      },
    ]);
    expect(normalize(frame("session.usage.updated", { cost: 1 }))).toEqual([]);
  });

  it("gives text/reasoning snapshots the same part identity as deltas", () => {
    const normalize = createOpenCodeV2EventNormalizer();
    const started = normalize(frame("session.text.started", { ordinal: 3 }))[0];
    const delta = normalize(frame("session.text.delta", { ordinal: 3, delta: "hello" }))[0];
    const ended = normalize(frame("session.text.ended", { ordinal: 3, text: "hello" }))[0];
    expect(started).toMatchObject({
      properties: { sessionID: "s", part: { id: "m:t3", text: "" } },
    });
    expect(delta).toMatchObject({ properties: { partID: "m:t3" } });
    expect(ended).toMatchObject({
      properties: { part: { id: "m:t3", text: "hello", time: { end: 0 } } },
    });
    expect(normalize(frame("session.reasoning.started", { ordinal: 3 }))[0]).toMatchObject({
      properties: { part: { id: "m:r3" } },
    });
  });

  it("scopes tool caches by child session/message and retains provider call identity", () => {
    const normalize = createOpenCodeV2EventNormalizer();
    normalize(frame("session.tool.input.started", { id: "call", name: "read", timestamp: 1 }));
    normalize(
      frame("session.tool.input.started", {
        sessionID: "child",
        id: "call",
        name: "bash",
        timestamp: 2,
      }),
    );
    expect(
      normalize(frame("session.tool.called", { id: "call", input: { file: "a" } }))[0],
    ).toMatchObject({
      properties: {
        sessionID: "s",
        part: {
          id: "s:m:call",
          callID: "call",
          tool: "read",
          state: { status: "running", input: { file: "a" }, time: { start: 1 } },
        },
      },
    });
    expect(
      normalize(
        frame("session.tool.success", {
          sessionID: "child",
          id: "call",
          content: [{ type: "text", text: "ok" }],
        }),
      )[0],
    ).toMatchObject({
      properties: {
        sessionID: "child",
        part: { tool: "bash", state: { status: "completed", output: "ok", time: { start: 2 } } },
      },
    });
    expect(
      normalize(
        frame("session.tool.failed", {
          id: "call",
          error: { type: "tool.failed", message: "oops" },
        }),
      )[0],
    ).toMatchObject({
      properties: { part: { tool: "read", state: { status: "error", error: "oops" } } },
    });
  });

  it("rejects non-event input without producing incomplete session events", () => {
    const normalize = createOpenCodeV2EventNormalizer();
    expect(normalize(null)).toEqual([]);
    expect(normalize({ type: "session.text.delta", data: { sessionID: "s", delta: "x" } })).toEqual(
      [],
    );
    expect(normalize({ type: "session.execution.started", data: {} })).toEqual([]);
  });
});
