// FILE: useThreadRecap.ts
// Purpose: Idle-generate compact per-thread recaps without wiring into transcript rendering.
// Layer: React hook
// Exports: useThreadRecap for the Environment panel.

import type { ProviderStartOptions, ThreadId } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  deriveThreadRecapSource,
  persistThreadRecapCache,
  readPersistedThreadRecapCache,
  resolveThreadRecapIdleMs,
  shouldScheduleThreadRecapGeneration,
  upsertPersistedThreadRecap,
  type PersistedThreadRecap,
} from "~/lib/threadRecap";
import { readNativeApi } from "~/nativeApi";
import type { Thread } from "~/types";

interface ThreadRecapCacheEntry {
  readonly text: string;
  readonly coveredMessageId: string | null;
  readonly sourceSignature: string;
  readonly status: "idle" | "pending" | "error";
  readonly updatedAt: string | null;
}

export interface UseThreadRecapInput {
  readonly thread: Thread | null | undefined;
  readonly cwd: string | null;
  readonly enabled: boolean;
  readonly latestTurnSettled: boolean;
  readonly codexHomePath?: string | null;
  readonly providerOptions?: ProviderStartOptions | null;
  readonly initialIdleMs?: number;
  readonly refreshIdleMs?: number;
  readonly idleMs?: number;
}

export interface UseThreadRecapResult {
  readonly text: string | null;
  readonly status: "idle" | "pending" | "error";
  readonly updatedAt: string | null;
}

function hydrateThreadRecapCache(): Partial<Record<ThreadId, ThreadRecapCacheEntry>> {
  return Object.fromEntries(
    Object.entries(readPersistedThreadRecapCache()).map(([threadId, entry]) => [
      threadId,
      { ...entry, status: "idle" },
    ]),
  ) as Partial<Record<ThreadId, ThreadRecapCacheEntry>>;
}

// Debounces recap generation until a thread is quiet and the latest assistant output settled.
export function useThreadRecap(input: UseThreadRecapInput): UseThreadRecapResult {
  const [cacheByThreadId, setCacheByThreadId] =
    useState<Partial<Record<ThreadId, ThreadRecapCacheEntry>>>(hydrateThreadRecapCache);
  const inFlightSignatureByThreadIdRef = useRef<Partial<Record<ThreadId, string>>>({});
  const failedSignatureByThreadIdRef = useRef<Partial<Record<ThreadId, string>>>({});
  const latestSourceSignatureByThreadIdRef = useRef<Partial<Record<ThreadId, string>>>({});
  const thread = input.thread ?? null;
  const cacheEntry = thread ? cacheByThreadId[thread.id] : undefined;
  // Keep recap input derivation off the render hot path unless a visible panel can generate.
  const shouldPrepareRecapSource = input.enabled && input.latestTurnSettled && thread !== null;
  const idleMs = resolveThreadRecapIdleMs({
    hasExistingRecap: Boolean(cacheEntry?.text),
    idleMsOverride: input.idleMs,
    initialIdleMsOverride: input.initialIdleMs,
    refreshIdleMsOverride: input.refreshIdleMs,
  });
  const threadMessages = thread?.messages;
  const hasStreamingAssistant = useMemo(() => {
    if (!shouldPrepareRecapSource || !threadMessages) return false;
    return threadMessages.some((message) => message.role === "assistant" && message.streaming);
  }, [shouldPrepareRecapSource, threadMessages]);
  const shouldDeriveRecapSource = shouldPrepareRecapSource && !hasStreamingAssistant;

  const source = useMemo(() => {
    if (!thread || !shouldDeriveRecapSource) return null;
    return deriveThreadRecapSource({
      thread,
      previousCoveredMessageId: cacheEntry?.coveredMessageId ?? null,
      hasPreviousRecap: Boolean(cacheEntry?.text),
    });
  }, [cacheEntry?.coveredMessageId, cacheEntry?.text, shouldDeriveRecapSource, thread]);
  const sourceHasNewMaterial = source?.hasNewMaterial ?? false;
  const sourceSignature = source?.signature ?? null;
  const sourceNewMaterial = source?.newMaterial ?? "";
  const sourceCurrentState = source?.currentState ?? "";
  const sourceLatestMessageId = source?.latestMessageId ?? null;
  const threadId = thread?.id ?? null;
  const sourcePayloadRef = useRef({
    newMaterial: sourceNewMaterial,
    currentState: sourceCurrentState,
    latestMessageId: sourceLatestMessageId,
  });
  if (threadId && sourceSignature) {
    latestSourceSignatureByThreadIdRef.current[threadId] = sourceSignature;
  }

  useEffect(() => {
    sourcePayloadRef.current = {
      newMaterial: sourceNewMaterial,
      currentState: sourceCurrentState,
      latestMessageId: sourceLatestMessageId,
    };
  }, [sourceCurrentState, sourceLatestMessageId, sourceNewMaterial]);

  useEffect(() => {
    if (
      !shouldScheduleThreadRecapGeneration({
        cachedSourceSignature: cacheEntry?.sourceSignature,
        cwd: input.cwd,
        enabled: input.enabled,
        failedSourceSignature: threadId
          ? failedSignatureByThreadIdRef.current[threadId]
          : undefined,
        hasStreamingAssistant,
        inFlightSourceSignature: threadId
          ? inFlightSignatureByThreadIdRef.current[threadId]
          : undefined,
        latestTurnSettled: input.latestTurnSettled,
        sourceHasNewMaterial,
        sourceSignature,
        threadId,
      })
    ) {
      return;
    }

    const cwd = input.cwd;
    const scheduledThreadId = threadId;
    const scheduledSourceSignature = sourceSignature;
    if (!cwd || !scheduledThreadId || !scheduledSourceSignature) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const payload = sourcePayloadRef.current;
      const api = readNativeApi();
      if (!api) {
        return;
      }

      inFlightSignatureByThreadIdRef.current[scheduledThreadId] = scheduledSourceSignature;
      setCacheByThreadId((current) => ({
        ...current,
        [scheduledThreadId]: {
          text: current[scheduledThreadId]?.text ?? "",
          coveredMessageId: current[scheduledThreadId]?.coveredMessageId ?? null,
          sourceSignature: current[scheduledThreadId]?.sourceSignature ?? "",
          status: "pending",
          updatedAt: current[scheduledThreadId]?.updatedAt ?? null,
        },
      }));

      void api.server
        .generateThreadRecap({
          cwd,
          newMaterial: payload.newMaterial,
          currentState: payload.currentState,
          ...(cacheEntry?.text ? { previousRecap: cacheEntry.text } : {}),
          ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        })
        .then((result) => {
          const isCurrentSource =
            latestSourceSignatureByThreadIdRef.current[scheduledThreadId] ===
            scheduledSourceSignature;
          if (
            inFlightSignatureByThreadIdRef.current[scheduledThreadId] === scheduledSourceSignature
          ) {
            delete inFlightSignatureByThreadIdRef.current[scheduledThreadId];
          }
          if (
            failedSignatureByThreadIdRef.current[scheduledThreadId] === scheduledSourceSignature
          ) {
            delete failedSignatureByThreadIdRef.current[scheduledThreadId];
          }
          if (!isCurrentSource) {
            return;
          }
          const persistedEntry = {
            text: result.recap,
            coveredMessageId: payload.latestMessageId,
            sourceSignature: scheduledSourceSignature,
            updatedAt: new Date().toISOString(),
          } satisfies PersistedThreadRecap;
          setCacheByThreadId((current) => ({
            ...current,
            [scheduledThreadId]: { ...persistedEntry, status: "idle" },
          }));
          persistThreadRecapCache(
            upsertPersistedThreadRecap(
              readPersistedThreadRecapCache(),
              scheduledThreadId,
              persistedEntry,
            ),
          );
        })
        .catch((error: unknown) => {
          const isCurrentSource =
            latestSourceSignatureByThreadIdRef.current[scheduledThreadId] ===
            scheduledSourceSignature;
          if (
            inFlightSignatureByThreadIdRef.current[scheduledThreadId] === scheduledSourceSignature
          ) {
            delete inFlightSignatureByThreadIdRef.current[scheduledThreadId];
          }
          if (!isCurrentSource) {
            return;
          }
          failedSignatureByThreadIdRef.current[scheduledThreadId] = scheduledSourceSignature;
          console.warn("Failed to generate thread recap", error);
          setCacheByThreadId((current) => ({
            ...current,
            [scheduledThreadId]: {
              text: current[scheduledThreadId]?.text ?? "",
              coveredMessageId: current[scheduledThreadId]?.coveredMessageId ?? null,
              sourceSignature: current[scheduledThreadId]?.sourceSignature ?? "",
              status: "error",
              updatedAt: current[scheduledThreadId]?.updatedAt ?? null,
            },
          }));
        });
    }, idleMs);

    return () => window.clearTimeout(timeoutId);
  }, [
    cacheEntry?.sourceSignature,
    cacheEntry?.text,
    hasStreamingAssistant,
    idleMs,
    input.codexHomePath,
    input.cwd,
    input.enabled,
    input.initialIdleMs,
    input.latestTurnSettled,
    input.providerOptions,
    input.refreshIdleMs,
    sourceHasNewMaterial,
    sourceSignature,
    threadId,
  ]);

  return {
    text: cacheEntry?.text ? cacheEntry.text : null,
    status: cacheEntry?.status ?? "idle",
    updatedAt: cacheEntry?.updatedAt ?? null,
  };
}
