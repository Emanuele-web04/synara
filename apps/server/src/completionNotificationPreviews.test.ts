import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  COMPLETION_PREVIEW_DOMAIN,
  COMPLETION_PREVIEW_PROOF_TYPE,
  type CompletionPreviewWatch,
  type LiveActivityHostSnapshot,
} from "@synara/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { attachCompletionPreviews } from "./completionNotificationPreviews";
import { makeRemoteDeviceTrustRepository } from "./persistence/Layers/RemoteDeviceTrust";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { initializeRemoteTlsIdentity, remoteTlsAnchor } from "./remoteTransport/certificates";

const host = {
  hostId: "00000000-0000-4000-8000-000000000001",
  environmentId: "00000000-0000-4000-8000-000000000002",
  accountAuthority: "https://account.example.test/api/v1",
  userId: "test-owner",
  organizationId: "test-org",
};
const at = "2026-11-06T12:00:00.000Z";
const threadId = "thread:💬";
const originalTurn = "original";
const effectiveTurnId = "resumed";
const displayId = "test:å:💬";
const expected = {
  title: "Final task 😀",
  provider: "Claude",
  firstLine: "Caffè ready 😀 and report.",
};

it("encrypts only the settled final line for the approved recipient and keeps generic delivery safe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synara-notification-preview-"));
  try {
    const tlsIdentityPath = join(directory, "remote-tls.json");
    const { rootFingerprint } = remoteTlsAnchor(
      await initializeRemoteTlsIdentity(tlsIdentityPath, host.environmentId),
    );
    const signing = await generateKeyPair("ES256");
    const publicKey = await exportJWK(signing.publicKey);
    const deviceJkt = await calculateJwkThumbprint(publicKey);
    const recipient = createECDH("prime256v1");
    const key = recipient.generateKeys().toString("base64url");
    const binding = {
      notificationId: "00000000-0000-4000-8000-000000000003",
      deviceJkt,
      threadId,
      turnId: originalTurn,
      displayId,
    };
    const now = Math.floor(Date.now() / 1_000);
    const proof = await new SignJWT({ ...binding, hostId: host.hostId, key })
      .setProtectedHeader({ alg: "ES256", typ: COMPLETION_PREVIEW_PROOF_TYPE })
      .setIssuer("synara-device")
      .setAudience(`synara-host:${host.environmentId}`)
      .setSubject(host.userId)
      .setIssuedAt(now)
      .setExpirationTime(now + 86_400)
      .sign(signing.privateKey);
    const watch: CompletionPreviewWatch = { ...binding, preview: { key, proof } };
    const snapshot: LiveActivityHostSnapshot = {
      sequence: 10,
      turns: [{ threadId, turnId: originalTurn, effectiveTurnId, state: "ready" }],
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const trust = { tlsIdentityPath, remoteTrust: yield* makeRemoteDeviceTrustRepository };
        yield* sql`INSERT INTO remote_access_state (environment_id, root_fingerprint, enabled, allow_connections)
          VALUES (${host.environmentId}, ${rootFingerprint}, 1, 1)`;
        yield* sql`INSERT INTO remote_device_trust
          (environment_id, root_fingerprint, device_jkt, device_public_key, account_authority,
           owner_user_id, organization_id, label, generation, approved_at, approved_invite_id)
          VALUES (${host.environmentId}, ${rootFingerprint}, ${deviceJkt}, ${JSON.stringify(publicKey)},
            ${host.accountAuthority}, ${host.userId}, ${host.organizationId}, 'Test', 1, ${at}, 'invite')`;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
          VALUES (${threadId}, 'test', ${expected.title}, ${at}, ${at})`;
        yield* sql`INSERT INTO projection_turns
          (thread_id, turn_id, state, assistant_message_id, requested_at, checkpoint_files_json)
          VALUES (${threadId}, ${effectiveTurnId}, 'completed', 'old-commentary', ${at}, '[]')`;
        const markdown =
          "<proposed_plan>Private plan</proposed_plan>\n\n```\nTHIS IS NOT THE ANSWER\n```\n\n**Caffè ready 😀** and [report](file:///private/path).\nNext line.";
        yield* sql`INSERT INTO projection_thread_messages
          (thread_id, message_id, turn_id, role, text, sequence, is_streaming, created_at, updated_at)
          VALUES
            (${threadId}, 'old-commentary', ${effectiveTurnId}, 'assistant', 'Private reasoning', 1, 0, ${at}, ${at}),
            (${threadId}, 'assistant:final', ${effectiveTurnId}, 'assistant', ${markdown}, 2, 0, ${at}, ${at}),
            (${threadId}, 'later-unrelated', 'other-turn', 'assistant', 'Unrelated secret', 3, 0, ${at}, ${at})`;
        yield* sql`INSERT INTO provider_runtime_events
          (sequence, event_id, thread_id, turn_id, event_type, event_json, persisted_at)
          VALUES
            (1, 'started', ${threadId}, ${effectiveTurnId}, 'turn.started', '{}', ${at}),
            (2, 'ended', ${threadId}, NULL, 'turn.completed',
             '{"provider":"claudeAgent","payload":{"state":"completed"}}', ${at}),
            (3, 'subagent-ended', ${threadId}, ${effectiveTurnId}, 'turn.completed',
             '{"parentTurnId":"parent","provider":"codex","payload":{"state":"completed"}}', ${at})`;
        yield* sql`UPDATE provider_runtime_event_consumers SET last_acked_sequence=3
          WHERE consumer_name='provider-runtime-ingestion.v1'`;

        const report = (watches: readonly CompletionPreviewWatch[], base = snapshot) =>
          attachCompletionPreviews(sql, base, watches, host, trust);
        const enriched = yield* report([watch]);
        expect(enriched.previews).toHaveLength(1);
        expect(JSON.stringify(enriched)).not.toContain(expected.title);
        expect(JSON.stringify(enriched)).not.toContain(expected.firstLine);
        const envelope = enriched.previews![0]!.preview;
        const context = (turn: string) =>
          Buffer.from(
            [
              COMPLETION_PREVIEW_DOMAIN,
              binding.notificationId,
              deviceJkt,
              host.hostId,
              threadId,
              originalTurn,
              turn,
              displayId,
            ]
              .map((part) => `${Buffer.byteLength(part)}:${part}`)
              .join(""),
          );
        const decrypt = (turn: string, input = envelope) => {
          const aad = context(turn);
          const shared = recipient.computeSecret(Buffer.from(input.ephemeralKey, "base64url"));
          const aesKey = Buffer.from(
            hkdfSync("sha256", shared, COMPLETION_PREVIEW_DOMAIN, aad, 32),
          );
          const ciphertext = Buffer.from(input.ciphertext, "base64url");
          const decipher = createDecipheriv(
            "aes-256-gcm",
            aesKey,
            Buffer.from(input.nonce, "base64url"),
          );
          decipher.setAAD(aad);
          decipher.setAuthTag(ciphertext.subarray(-16));
          return JSON.parse(
            Buffer.concat([
              decipher.update(ciphertext.subarray(0, -16)),
              decipher.final(),
            ]).toString(),
          ) as unknown;
        };
        expect(decrypt(effectiveTurnId)).toEqual(expected);
        expect(() => decrypt("wrong-turn")).toThrow();

        const substituted = createECDH("prime256v1");
        const replaced = {
          ...watch,
          preview: { proof, key: substituted.generateKeys().toString("base64url") },
        };
        expect(yield* report([replaced])).toEqual(snapshot);
        expect(yield* report([{ ...watch, displayId: "wrong-link" }])).toEqual(snapshot);

        const nearLimit = {
          ...snapshot,
          turns: [
            ...snapshot.turns,
            ...Array.from({ length: 145 }, (_, index) => ({
              threadId: `${index}${"x".repeat(196)}`,
              turnId: "y".repeat(200),
              state: "ready" as const,
            })),
          ],
        };
        expect(Buffer.byteLength(JSON.stringify(nearLimit))).toBeLessThan(65_536);
        expect(
          yield* report(
            Array.from({ length: 20 }, () => watch),
            nearLimit,
          ),
        ).toSatisfy(
          (result: LiveActivityHostSnapshot) =>
            result.turns.length === nearLimit.turns.length &&
            Buffer.byteLength(JSON.stringify(result)) <= 65_536,
        );

        yield* sql`UPDATE projection_thread_messages SET text = '![Image](file:///private/image.png)'
          WHERE thread_id=${threadId} AND message_id='assistant:final'`;
        const imageOnly = yield* report([watch]);
        expect(decrypt(effectiveTurnId, imageOnly.previews![0]!.preview)).toEqual({
          title: expected.title,
          provider: expected.provider,
        });

        yield* sql`UPDATE projection_thread_messages SET text=${markdown}
          WHERE thread_id=${threadId} AND message_id='assistant:final'`;
        yield* sql`INSERT INTO projection_thread_messages
          (thread_id,message_id,turn_id,role,text,sequence,is_streaming,created_at,updated_at)
          VALUES (${threadId}, 'assistant:late', ${effectiveTurnId}, 'assistant', 'Late progress',
            4, 0, ${at}, ${at})`;
        yield* sql`UPDATE provider_runtime_events SET event_json=json_set(event_json,'$.provider','codex')
          WHERE event_id='ended'`;
        yield* sql`INSERT INTO provider_runtime_events
          (sequence,event_id,thread_id,turn_id,event_type,event_json,persisted_at)
          VALUES
            (4, 'final-item', ${threadId}, ${effectiveTurnId}, 'item.completed',
             '{"provider":"codex","itemId":"final","payload":{"itemType":"assistant_message","data":{"item":{"phase":"final_answer"}}}}', ${at}),
            (5, 'late-item', ${threadId}, ${effectiveTurnId}, 'item.completed',
             '{"provider":"codex","itemId":"late","payload":{"itemType":"assistant_message","data":{"item":{"phase":"commentary"}}}}', ${at})`;
        yield* sql`UPDATE provider_runtime_event_consumers SET last_acked_sequence=5
          WHERE consumer_name='provider-runtime-ingestion.v1'`;
        const afterLateCommentary = yield* report([watch]);
        expect(decrypt(effectiveTurnId, afterLateCommentary.previews![0]!.preview)).toEqual({
          ...expected,
          provider: "Codex",
        });
        yield* sql`UPDATE provider_runtime_events
          SET event_json=json_set(event_json,'$.payload.data.item.phase','partial_answer')
          WHERE event_id='final-item'`;
        const noDeclaredFinal = yield* report([watch]);
        expect(decrypt(effectiveTurnId, noDeclaredFinal.previews![0]!.preview)).toEqual({
          title: expected.title,
          provider: "Codex",
        });

        yield* sql`UPDATE remote_device_trust SET revoked_at=${at} WHERE device_jkt=${deviceJkt}`;
        expect(yield* report([watch])).toEqual(snapshot);
      }).pipe(Effect.provide(SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer)))),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
