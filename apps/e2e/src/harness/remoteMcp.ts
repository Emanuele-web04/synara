import type { OrchestrationThreadDetailSnapshot } from "@synara/contracts";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { workspaceRpc } from "./rpc";

/** A real provider-scoped MCP request crosses a real paired channel into the other built server. */
export async function verifyRemoteMcp(input: {
  controller: { origin: string; baseDir: string };
  host: { origin: string; baseDir: string };
  projectId: string;
}) {
  await using local = await workspaceRpc(input.controller.origin);
  await using remote = await workspaceRpc(input.host.origin);
  const descriptor = await remote.request<{ environmentId: string }>("server.getEnvironment");
  const threadId = randomUUID();
  for (const [rpc, title] of [
    [local, "LOCAL MCP caller"],
    [remote, "REMOTE MCP collision"],
  ] as const) {
    await rpc.request("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: randomUUID(),
      threadId,
      projectId: input.projectId,
      title,
      modelSelection: { provider: "codex", model: "gpt-6-astra" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      envMode: "local",
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    });
  }
  const environmentId = descriptor.environmentId;
  const creation = {
    name: "synara_create_thread",
    arguments: {
      environmentId,
      requestId: "remote-mcp-create",
      projectId: input.projectId,
      prompt: "Created by the remote MCP fixture",
      target: { provider: "codex", model: "gpt-6-astra" },
    },
  };
  await fs.writeFile(
    path.join(input.controller.baseDir, "mcp-fixture-plan.json"),
    JSON.stringify({
      endpoint: `${input.controller.origin}/mcp`,
      steps: [
        { name: "synara_list_connections", arguments: {} },
        { name: "synara_list_projects", arguments: { environmentId } },
        { name: "synara_list_threads", arguments: { environmentId, projectId: input.projectId } },
        { name: "synara_read_thread", arguments: { environmentId, threadId } },
        { name: "synara_capabilities", arguments: { environmentId, projectId: input.projectId } },
        creation,
        creation,
        {
          name: "synara_set_thread_title",
          arguments: { environmentId, threadId, title: "REMOTE MCP renamed" },
        },
        {
          name: "synara_send_message",
          arguments: { environmentId, threadId, message: "Remote fixture follow-up" },
        },
        {
          name: "synara_wait_for_threads",
          arguments: { environmentId, threadIds: [threadId], timeoutMs: 0 },
        },
      ],
    }),
  );
  // Loopback clients cannot manufacture a delegated agent principal.
  const denied = await local.request<{ isError?: boolean }>("agentGateway.call", {
    environmentId: (await local.request<{ environmentId: string }>("server.getEnvironment"))
      .environmentId,
    caller: {
      environmentId,
      threadId,
      turnId: null,
      provider: "codex",
      runtimeMode: "full-access",
      envMode: "local",
      capabilities: ["thread:read"],
    },
    tool: "synara_list_threads",
    arguments: {},
  });
  expect(denied.isError).toBe(true);
  await local.request("orchestration.dispatchCommand", {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text: "REMOTE MCP FIXTURE", attachments: [] },
    modelSelection: { provider: "codex", model: "gpt-6-astra" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  const resultsFile = path.join(input.controller.baseDir, "mcp-fixture-results.json");
  await expect
    .poll(
      async () =>
        fs.access(resultsFile).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  const results = JSON.parse(await fs.readFile(resultsFile, "utf8"));
  expect(Array.isArray(results), JSON.stringify(results)).toBe(true);
  expect(results).toHaveLength(10);
  for (const result of results) {
    expect(result.status).toBe(200);
    expect(result.body.result?.isError, JSON.stringify(result.body)).not.toBe(true);
    expect(result.body.error).toBeUndefined();
  }
  const data = results.map((result: { body: { result: { content: { text: string }[] } } }) =>
    JSON.parse(result.body.result.content[0]!.text),
  );
  expect(data[0].computers).toEqual(
    expect.arrayContaining([expect.objectContaining({ environmentId })]),
  );
  expect(data[1].projects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        projectId: input.projectId,
        title: "REMOTE checkout",
        environmentId,
      }),
    ]),
  );
  expect(data[2].threads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ threadId, title: "REMOTE MCP collision", environmentId }),
    ]),
  );
  expect(data[3]).toMatchObject({ threadId, title: "REMOTE MCP collision", environmentId });
  expect(data[5]).toEqual(data[6]);
  expect(data[5].environmentId).toBe(environmentId);
  expect(data[9].threads[0].readThread.arguments).toMatchObject({ threadId, environmentId });
  const localShell = await local.request<{ threads: { id: string; title: string }[] }>(
    "orchestration.getShellSnapshot",
  );
  expect(localShell.threads.find((thread) => thread.id === threadId)?.title).toBe(
    "LOCAL MCP caller",
  );
  expect(localShell.threads.some((thread) => thread.id === data[5].threadId)).toBe(false);
  // Dispose test chats so the existing sidebar fixture retains its original rows.
  for (const [rpc, ids] of [
    [local, [threadId]],
    [remote, [threadId, data[5].threadId]],
  ] as const) {
    for (const id of ids) {
      await expect
        .poll(
          async () => {
            const snapshot = await rpc.request<OrchestrationThreadDetailSnapshot>(
              "orchestration.getThreadDetailSnapshot",
              { threadId: id },
            );
            return snapshot.thread.session?.status;
          },
          { timeout: 15_000 },
        )
        .toBe("running");
      await rpc.request("orchestration.dispatchCommand", {
        type: "thread.turn.interrupt",
        commandId: randomUUID(),
        threadId: id,
        createdAt: new Date().toISOString(),
      });
      await expect
        .poll(
          async () => {
            const snapshot = await rpc.request<OrchestrationThreadDetailSnapshot>(
              "orchestration.getThreadDetailSnapshot",
              { threadId: id },
            );
            return snapshot.thread.latestTurn?.state;
          },
          { timeout: 15_000 },
        )
        .toBe("interrupted");
      await rpc.request("orchestration.dispatchCommand", {
        type: "thread.archive",
        commandId: randomUUID(),
        threadId: id,
      });
    }
  }
}
