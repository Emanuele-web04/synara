import assert from "node:assert/strict";
import { test } from "vitest";
import type { NotionApi, NotionChange, NotionWriteInput } from "@synara/contracts";
import { NotionWriteSession, type NotionWriteProposal } from "./notionWrites";

const proposal: NotionWriteProposal = {
  connectionId: "workspace",
  kind: "comment",
  id: "00000000-0000-4000-8000-000000000001",
  base: {},
  changes: { rich_text: [{ type: "text", text: { content: "Review complete" } }] },
};
function session() {
  let count = 0;
  return new NotionWriteSession(
    () => `00000000-0000-4000-8000-${String(++count).padStart(12, "0")}`,
    () => "2026-10-15T10:00:00.000Z",
  );
}
function result(
  input: NotionWriteInput,
  state: NotionChange["state"] = "synced",
): Awaited<ReturnType<NotionApi["write"]>> {
  return {
    change: {
      id: input.requestId,
      connectionId: input.connectionId,
      resourceId: input.id,
      kind: input.kind,
      state,
      message: null,
      createdAt: input.createdAt,
      base: input.base,
      changes: input.changes,
      remote: null,
    },
    data: { id: input.id },
  };
}

test("retains request ID, creation time and exact body after an interrupted response", async () => {
  const writer = session();
  const received: NotionWriteInput[] = [];
  const api: Pick<NotionApi, "write"> = {
    write: async (input) => {
      received.push(structuredClone(input));
      if (received.length === 1) throw new Error("Connection lost after sending");
      return result(input);
    },
  };
  await assert.rejects(writer.write(api, proposal), /Connection lost/);
  assert.equal(writer.awaitingConfirmation, true);
  await writer.write(api, proposal);
  assert.deepEqual(received[1], received[0]);
  assert.equal(writer.awaitingConfirmation, false);
});

test("coalesces concurrent duplicate clicks into one in-flight request", async () => {
  const writer = session();
  let calls = 0;
  let resolve: (() => void) | undefined;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  const api: Pick<NotionApi, "write"> = {
    write: async (input) => {
      calls++;
      await gate;
      return result(input);
    },
  };
  const first = writer.write(api, proposal);
  const second = writer.write(api, structuredClone(proposal));
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve!();
  await Promise.all([first, second]);
});

test("does not create another request ID for a pending or conflicting write", async () => {
  const writer = session();
  const received: NotionWriteInput[] = [];
  const api: Pick<NotionApi, "write"> = {
    write: async (input) => {
      received.push(input);
      return result(input, received.length === 1 ? "pending" : "conflict");
    },
  };
  await assert.rejects(writer.write(api, proposal), /retained for review/);
  await assert.rejects(writer.write(api, proposal), /retained for review/);
  assert.deepEqual(received[1], received[0]);
  assert.equal(writer.awaitingConfirmation, true);
});

test("rejects a different edit while the previous receipt is unconfirmed", async () => {
  const writer = session();
  const received: NotionWriteInput[] = [];
  const api: Pick<NotionApi, "write"> = {
    write: async (input) => {
      received.push(input);
      throw new Error("Offline");
    },
  };
  await assert.rejects(writer.write(api, proposal), /Offline/);
  await assert.rejects(
    writer.write(api, { ...proposal, changes: { different: true } }),
    /different edit/,
  );
  assert.equal(received.length, 1);
});

test("allows intentionally repeated content after a confirmed write with a new receipt", async () => {
  const writer = session();
  const received: NotionWriteInput[] = [];
  const api: Pick<NotionApi, "write"> = {
    write: async (input) => {
      received.push(input);
      return result(input);
    },
  };
  await writer.write(api, proposal);
  await writer.write(api, proposal);
  assert.notEqual(received[0]!.requestId, received[1]!.requestId);
});

test("does not let caller or transport mutation corrupt the retained receipt", async () => {
  const writer = session();
  const editable = structuredClone(proposal);
  const received: NotionWriteInput[] = [];
  const api: Pick<NotionApi, "write"> = {
    write: async (input) => {
      received.push(structuredClone(input));
      if (received.length === 1) {
        (input.changes as Record<string, unknown>).transportMutation = true;
        throw new Error("Offline");
      }
      return result(input);
    },
  };
  const pending = writer.write(api, editable);
  (editable.changes as Record<string, unknown>).callerMutation = true;
  await assert.rejects(pending, /Offline/);
  await writer.write(api, proposal);
  assert.deepEqual(received[1], received[0]);
});
