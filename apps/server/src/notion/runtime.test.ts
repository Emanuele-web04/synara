import { describe, expect, it, vi } from "vitest";
import { NotionClient } from "./client";
import { NotionRuntime } from "./runtime";
import { plainNotionText } from "@synara/shared/notion";
import type { NotionObject, TodoStreamEvent } from "@synara/contracts";
const workspace = "11111111-1111-4111-8111-111111111111";
const bot = "22222222-2222-4222-8222-222222222222";
const source = "33333333-3333-4333-8333-333333333333";
const pageId = "44444444-4444-4444-8444-444444444444";
const connectionId = `${workspace}:${bot}`;
const now = Date.parse("2026-10-15T12:00:00.000Z");
const stamp = new Date(now).toISOString();
async function fixture() {
  let page: NotionObject = {
    object: "page",
    id: pageId,
    parent: { type: "data_source_id", data_source_id: source },
    created_time: stamp,
    last_edited_time: stamp,
    in_trash: false,
    properties: {
      Renamed: { id: "title", type: "title", title: plainNotionText("Original") },
      Done: { id: "done", type: "checkbox", checkbox: false },
      Unknown: { id: "other", type: "formula", formula: { type: "number", number: 12 } },
    },
  };
  let denied = false;
  let uncertain = false;
  let stored = JSON.stringify({
    version: 1,
    connections: [
      {
        connection: {
          id: connectionId,
          workspaceId: workspace,
          workspaceName: "Fixture team",
          status: "connected",
          createdAt: stamp,
        },
        accessToken: "fixture-access",
        brokerSession: `${bot}.${"a".repeat(43)}`,
        brokerOrigin: "https://broker.example.test",
        botId: bot,
      },
    ],
    mappings: [
      {
        id: "tasks",
        connectionId,
        dataSourceId: source,
        name: "Engineering",
        projectId: null,
        fields: { title: { id: "title", type: "title" }, status: { id: "done", type: "checkbox" } },
        completedStatusIds: [],
        reopenedStatusId: null,
        priorityOptions: {},
        agentAccess: "none",
        enabled: true,
      },
    ],
    tasks: [],
    changes: [],
    pending: [],
  });
  const events: TodoStreamEvent[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (denied) return new Response("", { status: 403 });
    if (init?.method === "PATCH") {
      if (uncertain) throw new Error("lost reply");
      const input = JSON.parse(String(init.body)) as NotionObject;
      const properties = { ...(page.properties as object) };
      for (const [key, value] of Object.entries(properties)) {
        const property = value as NotionObject;
        const change = (input.properties as Record<string, unknown> | undefined)?.[
          String(property.id)
        ];
        if (change)
          properties[key as keyof typeof properties] = {
            ...property,
            ...(change as object),
          } as never;
      }
      page = { ...page, properties, ...(input.in_trash === true ? { in_trash: true } : {}) };
      return Response.json(page);
    }
    if (String(url).includes("/query"))
      return Response.json({ object: "list", results: [page], has_more: false, next_cursor: null });
    return Response.json(page);
  });
  const save = vi.fn(async (value: string) => {
    stored = value;
  });
  const create = async () => {
    const runtime = new NotionRuntime({
      brokerOrigin: "https://broker.example.test",
      load: async () => stored,
      save,
      publish: (event) => events.push(event),
      fetch: fetcher,
      now: () => now,
      client: (_connection, options) =>
        new NotionClient({ ...options, sleep: async () => {}, now: () => now }),
    });
    await runtime.init();
    return runtime;
  };
  const runtime = await create();
  await runtime.sync();
  const write = (title = "Mine") =>
    runtime.write({
      requestId: crypto.randomUUID(),
      createdAt: stamp,
      connectionId,
      kind: "updatePage",
      id: pageId,
      base: { title: { title: plainNotionText("Original") } },
      changes: { title: { title: plainNotionText(title) } },
    });
  return {
    runtime,
    write,
    create,
    save,
    fetcher,
    events,
    stored: () => stored,
    deny: () => {
      denied = true;
    },
    loseReply: () => {
      uncertain = true;
    },
    remoteEdit: () => {
      page = {
        ...page,
        properties: {
          ...(page.properties as object),
          Renamed: { id: "title", type: "title", title: plainNotionText("Other edit") },
        },
      };
    },
  };
}
describe("durable Notion provider", () => {
  it("deduplicates imports and keeps raw unmapped properties", async () => {
    const f = await fixture();
    await f.runtime.sync();
    expect(f.runtime.listTodos()).toHaveLength(1);
    expect(f.runtime.listTodos()[0]?.external.status).toBe("To do");
    expect(f.stored()).toContain('"other"');
    await f.runtime.dispose();
  });
  it("does not expose credentials in public state or task events", async () => {
    const f = await fixture();
    expect(JSON.stringify([f.runtime.state(), f.events])).not.toContain("fixture-access");
    expect(JSON.stringify(f.runtime.state())).not.toContain("brokerSession");
    await f.runtime.dispose();
  });
  it("persists a conflicting local proposal without sending a patch", async () => {
    const f = await fixture();
    f.remoteEdit();
    const result = await f.write();
    expect(result.change.state).toBe("conflict");
    expect(f.fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(f.runtime.listTodos()[0]?.title).toBe("Mine");
    expect(f.stored()).toContain("Other edit");
    await f.runtime.dispose();
  });
  it("never replays an uncertain write on sync or restart", async () => {
    const f = await fixture();
    f.loseReply();
    expect((await f.write()).change.state).toBe("unknown");
    await f.runtime.sync();
    const second = await f.create();
    await second.sync();
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(second.state().changes[0]?.state).toBe("unknown");
    await second.dispose();
    await f.runtime.dispose();
  });
  it("purges revoked resources rather than continuing to serve stale task context", async () => {
    const f = await fixture();
    f.deny();
    await expect(f.runtime.read({ connectionId, kind: "page", id: pageId })).rejects.toMatchObject({
      status: 403,
    });
    expect(f.runtime.listTodos()).toHaveLength(0);
    expect(f.stored()).not.toContain('"Renamed"');
    await f.runtime.dispose();
  });
  it("fails closed before sending a write if durable storage cannot be updated", async () => {
    const f = await fixture();
    f.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(f.write()).rejects.toThrow("storage");
    expect(f.fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    await expect(f.runtime.read({ connectionId, kind: "page", id: pageId })).rejects.toThrow(
      "storage",
    );
    await f.runtime.dispose();
  });
});
