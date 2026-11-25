import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import {
  COMPLETION_PREVIEW_DOMAIN,
  COMPLETION_PREVIEW_PROOF_TYPE,
  CompletionPreviewWatch,
  EnvironmentId,
  JWT_CLOCK_TOLERANCE_SECONDS,
  PROVIDER_DISPLAY_NAMES,
  ProviderKind,
  SYNARA_DEVICE_ISSUER,
  type CompletionPreviewHostReport,
  type DevicePublicKeyJwk,
  type LiveActivityHostSnapshot,
  type RemoteTrustScope,
} from "@synara/contracts";
import { Effect, Option, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { calculateJwkThumbprint, importJWK, jwtVerify } from "jose";
import { fromMarkdown } from "mdast-util-from-markdown";
import { assertBoundedLifetime } from "./hostAuth/grantVerifier";
import { PROVIDER_RUNTIME_INGESTION_CONSUMER } from "./persistence/Services/ProviderRuntimeEvents";
import type { RemoteDeviceTrustRepositoryShape } from "./persistence/Services/RemoteDeviceTrust";
import { readCodexAssistantPhases } from "./provider/codexAssistantPhases";
import { readRemoteTlsTrustAnchor } from "./remoteTransport/certificates";

const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_MARKDOWN_CHARS = 4096;
const MAX_PROOF_AGE_SECONDS = 24 * 60 * 60;
const PreviewWatches = Schema.Array(CompletionPreviewWatch).check(Schema.isMaxLength(64));

interface PreviewHost {
  readonly environmentId: string;
  readonly hostId: string;
  readonly accountAuthority: string;
  readonly userId: string;
  readonly organizationId: string;
}

export interface CompletionPreviewTrust {
  readonly remoteTrust: RemoteDeviceTrustRepositoryShape;
  readonly tlsIdentityPath: string;
}

type PreviewContent = {
  readonly title: string;
  readonly provider: string;
  readonly firstLine?: string;
};

function notificationLine(value: string, maxBytes: number): string {
  const text = value
    .replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  let size = 0;
  let end = 0;
  for (const scalar of text) {
    size += Buffer.byteLength(scalar);
    if (size > maxBytes) return `${text.slice(0, end).trimEnd()}…`;
    end += scalar.length;
  }
  return text;
}

type MarkdownNode = {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly MarkdownNode[];
};

function inlineText(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  if (node.type === "break") return "\n";
  return node.children?.map(inlineText).join("") ?? "";
}

function firstVisibleLine(node: MarkdownNode): string {
  if (node.type === "paragraph" || node.type === "heading") {
    for (const line of inlineText(node).split(/\r?\n/u)) {
      const visible = notificationLine(line, 220);
      if (visible) return visible;
    }
  } else {
    for (const child of node.children ?? []) {
      const line = firstVisibleLine(child);
      if (line) return line;
    }
  }
  return "";
}

function readFinalPreview(sql: SqlClient.SqlClient, threadId: string, turnId: string) {
  return Effect.gen(function* () {
    // The durable terminal record proves the exact provider and that the visible
    // assistant message belongs to a finished run. Some adapters omit terminal
    // turn IDs, so accept those only when the journal's latest start owns them.
    const [row] = yield* sql<{ title: string; provider: unknown }>`
      SELECT substr(thread.title, 1, ${MAX_MARKDOWN_CHARS}) AS title,
        json_extract(terminal.event_json, '$.provider') AS provider
      FROM projection_turns AS turn
      JOIN projection_threads AS thread ON thread.thread_id = turn.thread_id
      JOIN provider_runtime_events AS terminal ON terminal.thread_id = turn.thread_id
        AND terminal.event_type = 'turn.completed'
        AND json_extract(terminal.event_json, '$.parentTurnId') IS NULL
        AND json_extract(terminal.event_json, '$.payload.state') = 'completed'
        AND (terminal.turn_id = turn.turn_id OR (terminal.turn_id IS NULL AND (
          SELECT started.turn_id FROM provider_runtime_events AS started
          WHERE started.thread_id = turn.thread_id AND started.event_type = 'turn.started'
            AND started.sequence < terminal.sequence AND started.turn_id IS NOT NULL
            AND json_extract(started.event_json, '$.parentTurnId') IS NULL
          ORDER BY started.sequence DESC LIMIT 1
        ) = turn.turn_id))
      WHERE turn.thread_id = ${threadId} AND turn.turn_id = ${turnId} AND turn.state = 'completed'
        AND terminal.sequence <= COALESCE((SELECT last_acked_sequence FROM provider_runtime_event_consumers
          WHERE consumer_name = ${PROVIDER_RUNTIME_INGESTION_CONSUMER}), 0)
      ORDER BY terminal.sequence DESC LIMIT 1`;
    if (!row || !Schema.is(ProviderKind)(row.provider)) return undefined;
    const title = notificationLine(row.title, 200);
    if (!title) return undefined;
    const provider = PROVIDER_DISPLAY_NAMES[row.provider];
    const phases =
      row.provider === "codex" ? yield* readCodexAssistantPhases(sql, threadId, turnId) : undefined;
    if (phases?.hasPhases && !phases.finalMessageId) return { title, provider };

    // Where providers omit phase metadata, match the transcript's newest
    // assistant row by causal order. Choose before checking its stream status,
    // so an older progress line never stands in for an unfinished final row.
    const [message] = yield* sql<{ markdown: string | null }>`
      SELECT CASE WHEN is_streaming = 0 AND async_user_input_json IS NULL THEN
        substr(COALESCE(json_extract(text_json, '$'), text), 1, ${MAX_MARKDOWN_CHARS})
        END AS markdown
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND turn_id = ${turnId} AND role = 'assistant'
        ${phases?.finalMessageId ? sql`AND message_id = ${phases.finalMessageId}` : sql``}
      ORDER BY sequence DESC, created_at DESC, message_id DESC LIMIT 1`;
    const markdown = message?.markdown?.replace(
      /<proposed_plan>[\s\S]*?(?:<\/proposed_plan>|$)/giu,
      "",
    );
    const firstLine = markdown ? firstVisibleLine(fromMarkdown(markdown)) : "";
    return {
      title,
      provider,
      ...(firstLine ? { firstLine } : {}),
    } satisfies PreviewContent;
  });
}

async function verifyRecipient(
  host: PreviewHost,
  watch: CompletionPreviewWatch,
  deviceKey: DevicePublicKeyJwk,
): Promise<boolean> {
  if (deviceKey.kty !== "EC") return false;
  try {
    const { preview, ...binding } = watch;
    if ((await calculateJwkThumbprint(deviceKey)) !== watch.deviceJkt) return false;
    const { payload } = await jwtVerify(preview.proof, await importJWK(deviceKey, "ES256"), {
      algorithms: ["ES256"],
      typ: COMPLETION_PREVIEW_PROOF_TYPE,
      issuer: SYNARA_DEVICE_ISSUER,
      audience: `synara-host:${host.environmentId}`,
      subject: host.userId,
      requiredClaims: ["iat", "exp"],
      clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
    });
    if (
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp)
    )
      return false;
    assertBoundedLifetime(
      { iat: payload.iat, exp: payload.exp },
      MAX_PROOF_AGE_SECONDS,
      "preview proof",
      Math.floor(Date.now() / 1_000),
    );
    return Object.entries({ ...binding, hostId: host.hostId, key: preview.key }).every(
      ([field, value]) => payload[field] === value,
    );
  } catch {
    return false;
  }
}

function encryptPreview(
  hostId: string,
  watch: CompletionPreviewWatch,
  effectiveTurnId: string,
  content: PreviewContent,
): CompletionPreviewHostReport | undefined {
  const { preview: recipient, ...binding } = watch;
  try {
    const recipientKey = Buffer.from(recipient.key, "base64url");
    if (
      recipientKey.length !== 65 ||
      recipientKey[0] !== 4 ||
      recipientKey.toString("base64url") !== recipient.key
    )
      return undefined;
    const ephemeral = createECDH("prime256v1");
    const ephemeralKey = ephemeral.generateKeys().toString("base64url");
    const context = Buffer.from(
      [
        COMPLETION_PREVIEW_DOMAIN,
        watch.notificationId,
        watch.deviceJkt,
        hostId,
        watch.threadId,
        watch.turnId,
        effectiveTurnId,
        watch.displayId,
      ]
        .map((part) => `${Buffer.byteLength(part)}:${part}`)
        .join(""),
    );
    const key = Buffer.from(
      hkdfSync(
        "sha256",
        ephemeral.computeSecret(recipientKey),
        COMPLETION_PREVIEW_DOMAIN,
        context,
        32,
      ),
    );
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(content), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64url");
    return {
      ...binding,
      effectiveTurnId,
      recipientKey: recipient.key,
      preview: { v: 1, ephemeralKey, nonce: nonce.toString("base64url"), ciphertext },
    };
  } catch {
    return undefined;
  }
}

export function attachCompletionPreviews(
  sql: SqlClient.SqlClient,
  snapshot: LiveActivityHostSnapshot,
  rawWatches: unknown,
  host: PreviewHost,
  trust: CompletionPreviewTrust,
) {
  return Effect.gen(function* () {
    const watches = Schema.decodeUnknownOption(PreviewWatches)(rawWatches);
    if (Option.isNone(watches) || watches.value.length === 0) return snapshot;
    const ready = new Map(
      snapshot.turns
        .filter((turn) => turn.state === "ready")
        .map((turn) => [
          JSON.stringify([turn.threadId, turn.turnId]),
          turn.effectiveTurnId ?? turn.turnId,
        ]),
    );
    if (ready.size === 0) return snapshot;
    const scope: RemoteTrustScope | undefined = yield* Effect.promise(async () => {
      try {
        const anchor = await readRemoteTlsTrustAnchor(trust.tlsIdentityPath, host.environmentId);
        return {
          environmentId: EnvironmentId.makeUnsafe(host.environmentId),
          rootFingerprint: anchor.rootFingerprint,
          accountAuthority: host.accountAuthority,
          userId: host.userId,
          organizationId: host.organizationId,
        };
      } catch {
        return undefined;
      }
    });
    if (!scope) return snapshot;

    const reports: CompletionPreviewHostReport[] = [];
    const contents = new Map<string, PreviewContent | undefined>();
    let bytes = Buffer.byteLength(JSON.stringify(snapshot)) + Buffer.byteLength(',"previews":[]');
    for (const watch of watches.value) {
      const effectiveTurnId = ready.get(JSON.stringify([watch.threadId, watch.turnId]));
      if (!effectiveTurnId) continue;
      const trusted = yield* trust.remoteTrust.authorize(scope, watch.deviceJkt);
      if (
        !trusted ||
        !(yield* Effect.promise(() => verifyRecipient(host, watch, trusted.publicKey)))
      )
        continue;
      const turn = JSON.stringify([watch.threadId, effectiveTurnId]);
      if (!contents.has(turn)) {
        contents.set(turn, yield* readFinalPreview(sql, watch.threadId, effectiveTurnId));
      }
      const content = contents.get(turn);
      const report = content && encryptPreview(host.hostId, watch, effectiveTurnId, content);
      if (!report) continue;
      bytes += Buffer.byteLength(JSON.stringify(report)) + (reports.length === 0 ? 0 : 1);
      if (bytes > MAX_SNAPSHOT_BYTES) break;
      reports.push(report);
    }
    return reports.length > 0 ? { ...snapshot, previews: reports } : snapshot;
  }).pipe(Effect.catchCause(() => Effect.succeed(snapshot)));
}
