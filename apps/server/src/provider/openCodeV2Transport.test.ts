import { describe, expect, it, vi } from "vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpenCodeClient } from "./openCodeClient.ts";
import { createOpenCodeV2Client } from "./openCodeV2Client.ts";
import type { OpenCodeV2Fetch } from "./openCodeV2TransportHttp.ts";

const session = {
  id: "ses_test",
  projectID: "project",
  location: { directory: "/test" },
  time: { created: 1, updated: 2 },
  cost: 0,
  tokens: {},
  permissions: [],
};
type Call = {
  path: string;
  method: string;
  headers: Headers;
  body: unknown;
  signal?: AbortSignal | null | undefined;
};
function fixture(respond: (call: Call, calls: Call[]) => unknown | Response) {
  const calls: Call[] = [];
  const fetchImpl: OpenCodeV2Fetch = async (url, init) => {
    const call = {
      path: new URL(String(url)).pathname + new URL(String(url)).search,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    const value = await respond(call, calls);
    return value instanceof Response ? value : Response.json(value);
  };
  return {
    calls,
    client: createOpenCodeV2Client({
      baseUrl: "http://localhost:5555",
      directory: "/a path/日本語",
      username: "opencode",
      password: "test-secret",
      version: "2.0.23",
      fetch: fetchImpl,
    }),
  };
}

describe("OpenCode v2 semantic transport", () => {
  it("keeps the legacy SDK structurally assignable to the narrow client", () => {
    const client: OpenCodeClient = createOpencodeClient({ baseUrl: "http://localhost:5555" });
    expect(client.session.create).toBeTypeOf("function");
  });

  it("creates and updates with explicit v2 permission rules, Basic auth and header-only scope", async () => {
    const { client, calls } = fixture((call) =>
      call.method === "PATCH" ? new Response(null, { status: 204 }) : { data: session },
    );
    await client.session.create({
      title: "Test",
      permission: [
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "edit", pattern: "*", action: "deny" },
      ],
    });
    await client.session.update({
      sessionID: session.id,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    });
    expect(calls[0]?.body).toEqual({
      title: "Test",
      location: { directory: "/a path/日本語" },
      permissions: [
        { action: "*", resource: "*", effect: "ask" },
        { action: "edit", resource: "*", effect: "deny" },
      ],
    });
    expect(calls[1]?.body).toEqual({
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    expect(calls[0]?.headers.get("x-opencode-directory")).toBe(
      encodeURIComponent("/a path/日本語"),
    );
    expect(calls[0]?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`,
    );
    expect(calls.every((call) => !call.path.includes("directory="))).toBe(true);
  });

  it.each([
    { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
    { providerID: "openrouter", modelID: "meta/muse-spark-1.3-contributor" },
  ])("preserves $providerID model routing before submitting text/files", async (model) => {
    const { client, calls } = fixture(() => ({ data: {} }));
    const controller = new AbortController();
    await client.session.promptAsync(
      {
        sessionID: session.id,
        model,
        variant: "high",
        agent: "build",
        system: "Harness policy",
        messageID: "msg_input",
        parts: [
          { type: "text", text: "Hello" },
          {
            type: "file",
            mime: "image/png",
            filename: "picture.png",
            url: "data:image/png;base64,eA==",
          },
        ],
      },
      { signal: controller.signal },
    );
    expect(calls.map((call) => call.path)).toEqual([
      "/api/session/ses_test/model",
      "/api/session/ses_test/agent",
      "/api/session/ses_test/prompt",
    ]);
    expect(calls[0]?.body).toEqual({
      model: { providerID: model.providerID, id: model.modelID, variant: "high" },
    });
    expect(calls[2]?.body).toEqual({
      text: "Harness policy\n\nHello",
      id: "msg_input",
      files: [{ uri: "data:image/png;base64,eA==", name: "picture.png" }],
    });
    controller.abort();
    expect(calls.every((call) => call.signal?.aborted)).toBe(true);
  });

  it("reports busy and idle for session-owned status and interrupts using v2", async () => {
    let busy = true;
    const { client, calls } = fixture((call) =>
      call.path === "/api/session/active"
        ? { data: busy ? { ses_test: {} } : {} }
        : call.path.endsWith("/interrupt")
          ? new Response(null, { status: 204 })
          : { data: session },
    );
    await client.session.get({ sessionID: session.id });
    expect((await client.session.status()).data?.ses_test).toEqual({ type: "busy" });
    busy = false;
    expect((await client.session.status()).data?.ses_test).toEqual({ type: "idle" });
    await client.session.abort({ sessionID: session.id });
    expect(calls.at(-1)?.path).toBe("/api/session/ses_test/interrupt");
  });

  it.each(["once", "reject"] as const)(
    "preserves explicit permission decision %s",
    async (reply) => {
      const { client, calls } = fixture((call) =>
        call.path === "/api/permission/request"
          ? {
              data: [
                {
                  id: "per_test",
                  sessionID: session.id,
                  action: "edit",
                  resources: ["file"],
                  save: ["*"],
                },
              ],
            }
          : new Response(null, { status: 204 }),
      );
      await client.permission.reply({ requestID: "per_test", reply });
      expect(calls.at(-1)?.path).toBe("/api/session/ses_test/permission/per_test/reply");
      expect(calls.at(-1)?.body).toEqual({ decision: reply });
    },
  );

  it("uses pre-2.0.4 permission field without changing approval policy", async () => {
    const calls: unknown[] = [];
    const client = createOpenCodeV2Client({
      baseUrl: "http://localhost:5555",
      version: "2.0.3",
      fetch: async (_url, init) => {
        calls.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return init?.method === "POST"
          ? new Response(null, { status: 204 })
          : Response.json({
              data: [
                { id: "per_test", sessionID: session.id, action: "edit", resources: ["file"] },
              ],
            });
      },
    });
    await client.permission.reply({ requestID: "per_test", reply: "once" });
    expect(calls.at(-1)).toEqual({ reply: "once" });
  });

  it("emulates session approval with session rules, suppressing grants during Plan", async () => {
    const { client, calls } = fixture((call) =>
      call.path === "/api/permission/request"
        ? {
            data: [
              {
                id: "per_test",
                sessionID: session.id,
                action: "shell",
                resources: ["git status --short"],
                save: ["git status *"],
              },
            ],
          }
        : call.method === "PATCH" || call.method === "POST"
          ? new Response(null, { status: 204 })
          : { data: session },
    );
    await client.session.get({ sessionID: session.id });
    await client.permission.reply({ requestID: "per_test", reply: "always" });
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      permissions: [{ action: "shell", resource: "git status *", effect: "allow" }],
    });
    expect(calls.at(-1)?.body).toEqual({ decision: "once" });
    await client.session.update({
      sessionID: session.id,
      permission: [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "read", pattern: "*", action: "allow" },
      ],
    });
    expect(calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ],
    });
    await expect(
      client.permission.reply({ requestID: "per_test", reply: "always" }),
    ).rejects.toThrow("Plan rules");
    await client.session.update({
      sessionID: session.id,
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    });
    expect(calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({
      permissions: [
        { action: "*", resource: "*", effect: "ask" },
        { action: "shell", resource: "git status *", effect: "allow" },
      ],
    });
    expect(
      calls.every((call) => !(JSON.stringify(call.body) ?? "").includes('"decision":"always"')),
    ).toBe(true);
  });

  it("projects question answers to keyed v2 forms and rejects through cancellation", async () => {
    const form = {
      id: "frm_test",
      sessionID: session.id,
      title: "Choose",
      fields: [
        {
          key: "pick",
          type: "string",
          title: "Pick",
          custom: false,
          options: [{ label: "One", value: "one" }],
        },
      ],
    };
    const { client, calls } = fixture((call) =>
      call.path === "/api/form" ? { data: [form] } : new Response(null, { status: 204 }),
    );
    await client.question.reply({ requestID: "frm_test", answers: [["One"]] });
    expect(calls.at(-1)?.body).toEqual({ answer: { pick: "one" } });
    await client.question.reject({ requestID: "frm_test" });
    expect(calls.at(-1)).toMatchObject({
      path: "/api/session/ses_test/form/frm_test",
      method: "DELETE",
    });
  });

  it("can cancel an unsupported pending form without swallowing network or missing-form errors", async () => {
    const form = {
      id: "frm_file",
      sessionID: session.id,
      title: "Upload",
      fields: [
        {
          key: "external",
          type: "external",
          title: "Open external form",
          url: "https://example.com",
        },
      ],
    };
    const { client, calls } = fixture((call) =>
      call.path === "/api/form" ? { data: [form] } : new Response(null, { status: 204 }),
    );
    await client.question.reject({ requestID: "frm_file" });
    expect(calls.at(-1)).toMatchObject({
      path: "/api/session/ses_test/form/frm_file",
      method: "DELETE",
    });
    await expect(client.question.reject({ requestID: "frm_missing" })).rejects.toThrow(
      "Unsupported",
    );
    const broken = fixture(() => new Response(null, { status: 503 }));
    await expect(broken.client.question.reject({ requestID: "frm_file" })).rejects.toThrow(
      "HTTP 503",
    );
  });

  it("registers MCP with disabled config and checks actual status", async () => {
    const { client, calls } = fixture((call) =>
      call.path === "/api/mcp"
        ? { data: [{ name: "synara", status: { status: "connected" } }] }
        : new Response(null, { status: 204 }),
    );
    const result = await client.mcp.add({
      name: "synara",
      config: {
        type: "remote",
        url: "http://localhost/mcp",
        enabled: true,
        oauth: false,
        headers: { Authorization: "Bearer task-token" },
        timeout: 5000,
      },
    });
    expect(calls[0]).toMatchObject({
      path: "/api/experimental/mcp/synara",
      method: "PUT",
      body: {
        config: {
          type: "remote",
          url: "http://localhost/mcp",
          disabled: false,
          codemode: false,
          oauth: false,
          headers: { Authorization: "Bearer task-token" },
          timeout: { startup: 5000, catalog: 5000, execution: 5000 },
        },
      },
    });
    expect(result.data?.synara).toEqual({ status: "connected" });
  });

  it("waits for the registered MCP server to leave pending and preserves explicit failures", async () => {
    let listing = 0;
    const { client } = fixture((call) =>
      call.path === "/api/mcp"
        ? {
            data: [
              { name: "synara", status: { status: ++listing === 1 ? "pending" : "connected" } },
              { name: "other", status: { status: "failed", error: "offline" } },
            ],
          }
        : new Response(null, { status: 204 }),
    );
    expect(
      (
        await client.mcp.add({
          name: "synara",
          config: { type: "remote", url: "http://localhost/mcp" },
        })
      ).data,
    ).toEqual({ synara: { status: "connected" }, other: { status: "failed", error: "offline" } });
    expect(listing).toBe(2);
  });

  it("cancels pending MCP startup using the caller signal", async () => {
    const controller = new AbortController();
    const { client } = fixture((call) => {
      if (call.path === "/api/mcp") {
        controller.abort();
        return { data: [{ name: "synara", status: { status: "pending" } }] };
      }
      return new Response(null, { status: 204 });
    });
    await expect(
      client.mcp.add(
        { name: "synara", config: { type: "remote", url: "http://localhost/mcp" } },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it("bounds ordinary HTTP requests including session updates and forwards cancellation", async () => {
    const signals: AbortSignal[] = [];
    const client = createOpenCodeV2Client({
      baseUrl: "http://localhost:5555",
      fetch: async (_url, init) => {
        if (!init?.signal) throw new Error("Missing request deadline");
        signals.push(init.signal);
        return new Response(null, { status: 204 });
      },
    });
    // A bounded PATCH must run even though the deliberately empty GET fails decoding.
    await expect(client.session.update({ sessionID: session.id, title: "new" })).rejects.toThrow();
    expect(signals).toHaveLength(2);
    const controller = new AbortController();
    await client.session.abort({ sessionID: session.id }, { signal: controller.signal });
    controller.abort();
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it("allows synchronous prompt waits longer than the ordinary HTTP deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const caller = new AbortController();
    let hasPrompt = false;
    const { client, calls } = fixture((call) => {
      if (call.path.endsWith("/prompt")) hasPrompt = true;
      if (call.path.includes("/message?"))
        return {
          data: hasPrompt
            ? [
                {
                  id: "msg_answer",
                  type: "assistant",
                  time: { created: 1, completed: 2 },
                  model: { id: "model", providerID: "provider" },
                  agent: "build",
                  content: [],
                },
              ]
            : [],
        };
      if (call.path.endsWith("/wait")) return new Response(null, { status: 204 });
      return { data: session };
    });
    try {
      await client.session.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "hi" }] },
        { signal: caller.signal },
      );
      const wait = calls.find((call) => call.path.endsWith("/wait"));
      expect(wait?.signal).toBe(caller.signal);
      expect(timeout).toHaveBeenCalledTimes(calls.length - 1);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each(["failed", "interrupted"])(
    "rejects a %s synchronous prompt instead of returning partial output",
    async (outcome) => {
      let hasPrompt = false;
      const { client } = fixture((call) => {
        if (call.path.endsWith("/prompt")) hasPrompt = true;
        if (call.path.includes("/message?")) return { data: [] };
        if (call.path.endsWith("/wait")) return new Response(null, { status: 204 });
        return { data: { ...session, ...(hasPrompt ? { outcome } : {}) } };
      });
      await expect(client.session.prompt({ sessionID: session.id })).rejects.toThrow(
        `prompt ${outcome}`,
      );
    },
  );

  it.each(["error", "incomplete"])(
    "rejects a synchronous prompt with an %s assistant record",
    async (kind) => {
      let hasPrompt = false;
      const { client } = fixture((call) => {
        if (call.path.endsWith("/prompt")) hasPrompt = true;
        if (call.path.includes("/message?"))
          return {
            data: hasPrompt
              ? [
                  {
                    id: "msg_answer",
                    type: "assistant",
                    agent: "build",
                    model: { id: "model", providerID: "provider" },
                    content: [],
                    time: { created: 1, ...(kind === "error" ? { completed: 2 } : {}) },
                    ...(kind === "error" ? { error: { type: "api", message: "Failure" } } : {}),
                  },
                ]
              : [],
          };
        if (call.path.endsWith("/wait")) return new Response(null, { status: 204 });
        return { data: session };
      });
      await expect(client.session.prompt({ sessionID: session.id })).rejects.toThrow(
        kind === "error" ? "assistant error" : "before its assistant message completed",
      );
    },
  );

  it("follows opaque cursors for children and refuses repeated cursors", async () => {
    const { client, calls } = fixture((call) => ({
      data: [{ ...session, id: call.path.includes("cursor=") ? "ses_second" : "ses_first" }],
      cursor: { next: call.path.includes("cursor=") ? null : "opaque" },
    }));
    expect(
      (await client.session.children({ sessionID: session.id })).data?.map((child) => child.id),
    ).toEqual(["ses_first", "ses_second"]);
    expect(calls[1]?.path).toBe("/api/session?parentID=ses_test&cursor=opaque");
    const repeated = fixture(() => ({ data: [], cursor: { next: "same" } }));
    await expect(repeated.client.session.children({ sessionID: session.id })).rejects.toThrow(
      "repeated pagination cursor",
    );
  });

  it("rejects unsupported legacy operations and HTTP errors without leaking auth or falling back", async () => {
    const { client, calls } = fixture(() => new Response("secret diagnostic", { status: 401 }));
    await expect(
      client.session.promptAsync({ sessionID: session.id, noReply: true }),
    ).rejects.toThrow("does not support legacy");
    await expect(client.experimental.console.get()).rejects.toThrow("does not expose");
    expect(calls).toHaveLength(0);
    await expect(client.session.abort({ sessionID: session.id })).rejects.toThrow("HTTP 401");
    expect(calls.map((call) => call.path)).toEqual(["/api/session/ses_test/interrupt"]);
  });
});
