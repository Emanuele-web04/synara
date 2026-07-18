import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

import { AuthClientSession } from "./auth";
import {
  COMPANION_RPC_METHOD_ALLOWLIST,
  COMPANION_RPC_METHODS,
  CompanionActivity,
  CompanionCreateThreadInput,
  CompanionError,
  CompanionHelloInput,
  CompanionProject,
  CompanionSendTurnInput,
  CompanionUpdateDeviceLabelInput,
} from "./companion";

const REQUEST_ID = "b7ce7301-e46a-4f1c-8d5d-27e6b856a12c";

it.effect("defaults pre-Companion auth sessions to full access", () =>
  Effect.sync(() => {
    const session = Schema.decodeUnknownSync(AuthClientSession)({
      sessionId: "session-1",
      subject: "owner",
      role: "owner",
      method: "browser-session-cookie",
      client: { deviceType: "desktop" },
      issuedAt: DateTime.makeUnsafe("2026-07-18T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2026-08-17T00:00:00.000Z"),
      lastConnectedAt: null,
      connected: false,
      current: true,
    });

    assert.equal(session.accessProfile, "full");
  }),
);

it.effect("keeps the Companion RPC allowlist closed and free of generic dispatch", () =>
  Effect.sync(() => {
    assert.deepEqual(COMPANION_RPC_METHOD_ALLOWLIST, Object.values(COMPANION_RPC_METHODS));
    assert.equal(COMPANION_RPC_METHOD_ALLOWLIST.length, 14);
    assert.equal(
      COMPANION_RPC_METHOD_ALLOWLIST.some((method) =>
        /dispatch|terminal|filesystem|settings|automation|git/i.test(method),
      ),
      false,
    );
  }),
);

it.effect("requires explicit confirmation before creating a full-access thread", () =>
  Effect.sync(() => {
    const decode = Schema.decodeUnknownSync(CompanionCreateThreadInput);
    assert.throws(() =>
      decode({
        requestId: REQUEST_ID,
        threadId: "thread-1",
        projectId: "project-1",
        providerId: "codex",
        modelId: "gpt-5.6",
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    );
    const accepted = decode({
      requestId: REQUEST_ID,
      threadId: "thread-1",
      projectId: "project-1",
      providerId: "codex",
      modelId: "gpt-5.6",
      runtimeMode: "full-access",
      interactionMode: "default",
      fullAccessConfirmed: true,
    });
    assert.equal(accepted.fullAccessConfirmed, true);
  }),
);

it.effect("redacts path and raw tool payload fields at the schema boundary", () =>
  Effect.sync(() => {
    const project = Schema.decodeUnknownSync(CompanionProject)({
      id: "project-1",
      kind: "project",
      title: "Synara",
      workspaceRoot: "C:/secret/repository",
      scripts: [{ name: "leak", command: "print-secret" }],
      defaultModelSelection: null,
      isPinned: false,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
    const activity = Schema.decodeUnknownSync(CompanionActivity)({
      id: "event-1",
      tone: "tool",
      kind: "tool.completed",
      summary: "Command completed",
      payload: { command: "cat C:/secret/file" },
      turnId: null,
      sequence: 1,
      createdAt: "2026-07-18T00:00:00.000Z",
    });

    assert.equal("workspaceRoot" in project, false);
    assert.equal("scripts" in project, false);
    assert.equal("payload" in activity, false);
  }),
);

it.effect("bounds turn payloads and accepts idempotency UUIDs", () =>
  Effect.sync(() => {
    const decode = Schema.decodeUnknownSync(CompanionSendTurnInput);
    const parsed = decode({
      requestId: REQUEST_ID,
      threadId: "thread-1",
      text: "Continue",
      attachmentIds: ["upload_1"],
      delivery: "steer",
    });
    assert.equal(parsed.requestId, REQUEST_ID);
    assert.equal(parsed.delivery, "steer");
    assert.throws(() =>
      decode({
        requestId: "not-a-uuid",
        threadId: "thread-1",
        text: "Continue",
        attachmentIds: [],
        delivery: "queue",
      }),
    );
    assert.throws(() =>
      decode({
        requestId: REQUEST_ID,
        threadId: "thread-1",
        text: "Continue",
        attachmentIds: Array.from({ length: 9 }, (_, index) => `upload_${index}`),
        delivery: "queue",
      }),
    );
  }),
);

it.effect("decodes safe tagged Companion errors", () =>
  Effect.sync(() => {
    const error = Schema.decodeUnknownSync(CompanionError)({
      _tag: "ProtocolMismatch",
      message: "Upgrade the client.",
      retryable: false,
    });
    assert.equal(error._tag, "ProtocolMismatch");
    assert.equal(error.retryable, false);
  }),
);

it.effect("allows unsupported hello versions through decoding for a typed mismatch response", () =>
  Effect.sync(() => {
    const input = Schema.decodeUnknownSync(CompanionHelloInput)({
      protocolVersion: 2,
      client: { name: "Future Companion", version: "2.0.0", platform: "web" },
    });
    assert.equal(input.protocolVersion, 2);
  }),
);

it.effect("trims and bounds Companion device labels", () =>
  Effect.sync(() => {
    const decode = Schema.decodeUnknownSync(CompanionUpdateDeviceLabelInput);

    expectLabel(decode({ deviceLabel: "  Khush's iPhone  " }).deviceLabel, "Khush's iPhone");
    assert.throws(() => decode({ deviceLabel: "   " }));
    assert.throws(() => decode({ deviceLabel: "x".repeat(81) }));
  }),
);

function expectLabel(actual: string, expected: string): void {
  assert.equal(actual, expected);
}
