// FILE: retryEffortVariantStore.ts
// Purpose: Client-persisted archive of superseded assistant attempts for effort retries.
// Layer: Web chat local state
// Depends on: zustand persist; keeps prior answers readable after edit-and-resend rollback.

import { type MessageId, type ProviderKind, type ThreadId, type TurnId } from "@synara/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { RetryEffortVariant } from "./retryWithDifferentEffort.logic";

type VariantGroupKey = string;

type VariantGroup = {
  readonly variants: RetryEffortVariant[];
  /** 0-based active index into `variants` (live attempt is usually last). */
  readonly activeIndex: number;
};

type RetryEffortVariantState = {
  readonly groups: Record<VariantGroupKey, VariantGroup>;
  archiveVariant: (input: {
    readonly threadId: ThreadId;
    readonly userMessageId: MessageId;
    readonly variant: RetryEffortVariant;
  }) => void;
  setActiveIndex: (input: {
    readonly threadId: ThreadId;
    readonly userMessageId: MessageId;
    readonly activeIndex: number;
  }) => void;
  clearGroup: (input: { readonly threadId: ThreadId; readonly userMessageId: MessageId }) => void;
};

function groupKey(threadId: ThreadId, userMessageId: MessageId): VariantGroupKey {
  return `${threadId}:${userMessageId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVariant(value: unknown): RetryEffortVariant | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.assistantMessageId !== "string") return null;
  if (typeof value.text !== "string" || typeof value.createdAt !== "string") return null;
  if (typeof value.provider !== "string" || typeof value.model !== "string") return null;
  return {
    id: value.id,
    assistantMessageId: value.assistantMessageId as MessageId,
    turnId: typeof value.turnId === "string" ? (value.turnId as TurnId) : null,
    text: value.text,
    effort: typeof value.effort === "string" ? value.effort : null,
    effortLabel: typeof value.effortLabel === "string" ? value.effortLabel : null,
    provider: value.provider as ProviderKind,
    model: value.model,
    createdAt: value.createdAt,
    checkpointTurnCount:
      typeof value.checkpointTurnCount === "number" ? value.checkpointTurnCount : null,
    changedFileCount: typeof value.changedFileCount === "number" ? value.changedFileCount : 0,
  };
}

function normalizeGroup(value: unknown): VariantGroup | null {
  if (!isRecord(value) || !Array.isArray(value.variants)) return null;
  const variants = value.variants
    .map(normalizeVariant)
    .filter((variant): variant is RetryEffortVariant => variant !== null);
  if (variants.length === 0) return null;
  const activeIndex =
    typeof value.activeIndex === "number" &&
    Number.isInteger(value.activeIndex) &&
    value.activeIndex >= 0 &&
    value.activeIndex <= variants.length
      ? value.activeIndex
      : variants.length;
  return { variants, activeIndex };
}

export function getRetryEffortVariantGroup(
  state: Pick<RetryEffortVariantState, "groups">,
  threadId: ThreadId,
  userMessageId: MessageId,
): VariantGroup | null {
  return state.groups[groupKey(threadId, userMessageId)] ?? null;
}

export const useRetryEffortVariantStore = create<RetryEffortVariantState>()(
  persist(
    (set, get) => ({
      groups: {},
      archiveVariant: ({ threadId, userMessageId, variant }) => {
        const key = groupKey(threadId, userMessageId);
        const existing = get().groups[key];
        const withoutDuplicate = (existing?.variants ?? []).filter(
          (candidate) => candidate.assistantMessageId !== variant.assistantMessageId,
        );
        const variants = [...withoutDuplicate, variant];
        set({
          groups: {
            ...get().groups,
            [key]: {
              variants,
              // Point at the upcoming live tip after merge (archived.length).
              activeIndex: variants.length,
            },
          },
        });
      },
      setActiveIndex: ({ threadId, userMessageId, activeIndex }) => {
        const key = groupKey(threadId, userMessageId);
        const existing = get().groups[key];
        if (!existing) return;
        // Allow one past archived length so the merged live tip stays selectable.
        if (activeIndex < 0 || activeIndex > existing.variants.length) return;
        set({
          groups: {
            ...get().groups,
            [key]: { ...existing, activeIndex },
          },
        });
      },
      clearGroup: ({ threadId, userMessageId }) => {
        const key = groupKey(threadId, userMessageId);
        if (!(key in get().groups)) return;
        const nextGroups = { ...get().groups };
        delete nextGroups[key];
        set({ groups: nextGroups });
      },
    }),
    {
      name: "synara.retry-effort-variants.v1",
      partialize: (state) => ({ groups: state.groups }),
      merge: (persistedState, currentState) => {
        if (!isRecord(persistedState) || !isRecord(persistedState.groups)) {
          return currentState;
        }
        const groups: Record<VariantGroupKey, VariantGroup> = {};
        for (const [key, value] of Object.entries(persistedState.groups)) {
          const group = normalizeGroup(value);
          if (group) groups[key] = group;
        }
        return { ...currentState, groups };
      },
    },
  ),
);
