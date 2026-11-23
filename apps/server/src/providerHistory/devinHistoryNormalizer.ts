// FILE: providerHistory/devinHistoryNormalizer.ts
// Purpose: Normalize raw Devin local/Cloud/ATIF transcripts into the
// ExternalHistoryMessage / ExternalHistorySessionDescriptor contract: stable
// upstream ids, user-visible filtering, deterministic ordering, content
// hashes, timestamp provenance. Pure functions; no I/O.
// Exports: normalizeLocalSessionCatalog, normalizeLocalTranscript,
// normalizeCloudCatalog, normalizeCloudMessages, normalizeAtifExport,
// NormalizedTranscript.

import { createHash } from "node:crypto";

import type { ExternalHistoryMessage, ExternalHistorySessionDescriptor } from "@synara/contracts";

import type { DevinAtifExport } from "./devinAtifHistory.ts";
import type { DevinCloudMessage, DevinCloudSession } from "./devinCloudHistory.ts";
import type { DevinLocalRawMessage, DevinLocalSessionRow } from "./devinLocalHistory.ts";

// Prompts Synara injected while hosting a session carry the harness policy
// block; imported history shows only the user's text (same treatment as
// OmpSessionHistory).
const SYNARA_HOST_CONTEXT_PATTERN = /<synara_host_context>[\s\S]*?<\/synara_host_context>/gu;

export interface NormalizedTranscript {
  readonly messages: ReadonlyArray<ExternalHistoryMessage>;
  readonly fidelity: {
    readonly readCount: number;
    readonly includedCount: number;
    readonly dropped: {
      readonly system: number;
      readonly tool: number;
      readonly hiddenUser: number;
      readonly empty: number;
      readonly duplicate: number;
      readonly unsupported: number;
    };
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function visibleUserText(content: string): string {
  return content.replace(SYNARA_HOST_CONTEXT_PATTERN, "").trim();
}

interface Candidate {
  readonly upstreamMessageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly originalTimestamp: string | null;
  readonly timestampProvenance: "source" | "fallback-deterministic";
  readonly sourceOrder: number;
  readonly sourceRevision: string | null;
  readonly bucket: keyof NormalizedTranscript["fidelity"]["dropped"] | null;
}

function finalize(candidates: ReadonlyArray<Candidate>): NormalizedTranscript {
  const dropped = {
    system: 0,
    tool: 0,
    hiddenUser: 0,
    empty: 0,
    duplicate: 0,
    unsupported: 0,
  };
  const seenIds = new Set<string>();
  const messages: Array<ExternalHistoryMessage> = [];
  for (const candidate of candidates) {
    if (candidate.bucket !== null) {
      dropped[candidate.bucket] += 1;
      continue;
    }
    if (seenIds.has(candidate.upstreamMessageId)) {
      dropped.duplicate += 1;
      continue;
    }
    seenIds.add(candidate.upstreamMessageId);
    messages.push({
      upstreamMessageId: candidate.upstreamMessageId,
      role: candidate.role,
      text: candidate.text,
      ...(candidate.originalTimestamp !== null
        ? { originalTimestamp: candidate.originalTimestamp }
        : {}),
      timestampProvenance: candidate.timestampProvenance,
      sourceOrder: candidate.sourceOrder,
      contentHash: hashText(candidate.text),
      ...(candidate.sourceRevision !== null ? { sourceRevision: candidate.sourceRevision } : {}),
    });
  }
  return {
    messages,
    fidelity: {
      readCount: candidates.length,
      includedCount: messages.length,
      dropped,
    },
  };
}

// ---------- Local store ----------

export function normalizeLocalSessionCatalog(
  sourceId: string,
  rows: ReadonlyArray<DevinLocalSessionRow>,
): ReadonlyArray<ExternalHistorySessionDescriptor> {
  return rows.map((row) => ({
    sourceId,
    externalSessionId: row.sessionId,
    ...(row.title !== null ? { title: row.title } : {}),
    sourceOrigin: "devin-local",
    ...(row.createdAt !== null ? { originalCreatedAt: row.createdAt } : {}),
    ...(row.lastActivityAt !== null ? { originalUpdatedAt: row.lastActivityAt } : {}),
    workspaceHint: row.workingDirectory,
    repositoryHints: row.workspaceDirs,
    ...(row.hidden ? { rawStatus: "hidden" } : {}),
  }));
}

/**
 * Local chain nodes → messages. Visibility mirrors the store's own FTS
 * trigger: role=assistant with non-empty text, or role=user with
 * metadata.is_user_input and non-empty text after stripping host context.
 * Fallback identity: `node-<nodeId>` keeps a deterministic stable id when the
 * stored message lacks `message_id`.
 */
export function normalizeLocalTranscript(
  nodes: ReadonlyArray<DevinLocalRawMessage>,
): NormalizedTranscript {
  const candidates: Array<Candidate> = nodes.map((node, index) => {
    const base = {
      upstreamMessageId: node.messageId ?? `node-${node.nodeId}`,
      sourceOrder: index,
      originalTimestamp: node.createdAt,
      timestampProvenance:
        node.createdAt !== null ? ("source" as const) : ("fallback-deterministic" as const),
      sourceRevision: node.createdAt,
    };
    if (node.role === "assistant") {
      if (node.content.trim().length === 0) {
        return { ...base, role: "assistant" as const, text: "", bucket: "empty" as const };
      }
      return {
        ...base,
        role: "assistant" as const,
        text: node.content,
        bucket: null,
      };
    }
    if (node.role === "user") {
      if (!node.isUserInput) {
        return { ...base, role: "user" as const, text: "", bucket: "hiddenUser" as const };
      }
      const text = visibleUserText(node.content);
      if (text.length === 0) {
        return { ...base, role: "user" as const, text: "", bucket: "empty" as const };
      }
      return { ...base, role: "user" as const, text, bucket: null };
    }
    if (node.role === "tool") {
      return { ...base, role: "assistant" as const, text: "", bucket: "tool" as const };
    }
    return { ...base, role: "assistant" as const, text: "", bucket: "system" as const };
  });
  return finalize(candidates);
}

// ---------- Cloud ----------

export function normalizeCloudCatalog(
  sourceId: string,
  sessions: ReadonlyArray<DevinCloudSession>,
): ReadonlyArray<ExternalHistorySessionDescriptor> {
  return sessions.map((session) => ({
    sourceId,
    externalSessionId: session.sessionId,
    ...(session.title !== null ? { title: session.title } : {}),
    sourceOrigin: "devin-cloud",
    ...(session.createdAt !== null ? { originalCreatedAt: session.createdAt } : {}),
    ...(session.updatedAt !== null ? { originalUpdatedAt: session.updatedAt } : {}),
    ...(session.url !== null ? { sourceUrl: session.url } : {}),
    ...(session.status !== null ? { rawStatus: session.status } : {}),
    ...(session.statusDetail !== null ? { rawStatusDetail: session.statusDetail } : {}),
  }));
}

export function normalizeCloudMessages(
  items: ReadonlyArray<DevinCloudMessage>,
): NormalizedTranscript {
  const candidates: Array<Candidate> = items.map((item, index) => {
    const base = {
      upstreamMessageId: item.eventId,
      sourceOrder: index,
      originalTimestamp: item.createdAt,
      timestampProvenance:
        item.createdAt !== null ? ("source" as const) : ("fallback-deterministic" as const),
      sourceRevision: item.createdAt,
    };
    if (item.message.trim().length === 0) {
      return {
        ...base,
        role: (item.source === "user" ? "user" : "assistant") as "user" | "assistant",
        text: "",
        bucket: "empty" as const,
      };
    }
    return {
      ...base,
      role: (item.source === "user" ? "user" : "assistant") as "user" | "assistant",
      text: item.source === "user" ? visibleUserText(item.message) : item.message,
      bucket: null,
    };
  });
  return finalize(candidates);
}

// ---------- ATIF ----------

/**
 * ATIF steps → messages. Steps without an upstream id get a deterministic
 * `atif-<sha8>-<index>` identity derived from (source, text, index) so repeated
 * imports of the same file dedupe cleanly while repeated identical messages
 * still survive separately (the index is part of the identity).
 */
export function normalizeAtifExport(atif: DevinAtifExport): NormalizedTranscript {
  const candidates: Array<Candidate> = atif.messages.map((step, index) => {
    const syntheticId = `atif-${hashText(`${step.source}:${index}:${step.text}`).slice(0, 12)}-${index}`;
    const base = {
      upstreamMessageId: step.stepId ?? syntheticId,
      sourceOrder: index,
      originalTimestamp: step.timestamp,
      timestampProvenance:
        step.timestamp !== null ? ("source" as const) : ("fallback-deterministic" as const),
      sourceRevision: step.timestamp,
    };
    if (step.source === "user" || step.source === "agent") {
      if (step.text.trim().length === 0) {
        return {
          ...base,
          role: step.source === "user" ? ("user" as const) : ("assistant" as const),
          text: "",
          bucket: "empty" as const,
        };
      }
      return {
        ...base,
        role: step.source === "user" ? ("user" as const) : ("assistant" as const),
        text: step.text,
        bucket: null,
      };
    }
    return {
      ...base,
      role: "assistant" as const,
      text: "",
      bucket: step.source === "tool" ? ("tool" as const) : ("system" as const),
    };
  });
  return finalize(candidates);
}
