// FILE: NativeIslandCoordinator.tsx
// Purpose: Hand bounded island snapshots to the optional macOS helper and keep React as the
//          authoritative fallback until the helper acknowledges the exact rendered revision.

import {
  ApprovalRequestId,
  ThreadId,
  type DesktopIslandAction,
  type DesktopIslandBridge,
  type DesktopIslandState,
  type ProviderApprovalDecision,
} from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import {
  type IslandViewModel,
  type NativeIslandSnapshot,
} from "~/components/dynamicIsland/islandViewModel";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

export type NativeIslandAction = DesktopIslandAction;
export type NativeIslandBridgeState = DesktopIslandState;
export type NativeIslandBridge = DesktopIslandBridge;

export const HIDDEN_NATIVE_ISLAND_SNAPSHOT: NativeIslandSnapshot = {
  version: 1,
  mode: "idle",
  primaryThreadId: null,
  sessions: [],
};

const MAX_REMEMBERED_ACTION_IDS = 256;

interface PublishedNativeIslandSnapshot {
  key: string;
  revision: number;
  snapshot: NativeIslandSnapshot;
}

export interface NativeIslandActionContext {
  revision: number;
  snapshot: NativeIslandSnapshot;
}

export interface NativeIslandActionDependencies {
  openThread: (threadId: string) => void | Promise<void>;
  respondToApproval: (input: {
    threadId: string;
    requestId: string;
    decision: ProviderApprovalDecision;
  }) => void | Promise<void>;
}

export interface NativeIslandCoordinatorProps {
  viewModel: IslandViewModel;
  enabled: boolean;
  windowFocused: boolean;
  onNativeSnapshotActive: (snapshotKey: string | null) => void;
}

export interface NativeIslandPublication {
  snapshot: NativeIslandSnapshot;
  snapshotKey: string | null;
}

export function nativeIslandSnapshotKey(snapshot: NativeIslandSnapshot): string {
  return JSON.stringify(snapshot);
}

export function resolveNativeIslandPublication(
  viewModel: IslandViewModel,
  enabled: boolean,
  windowFocused: boolean,
): NativeIslandPublication {
  if (!enabled || !windowFocused || viewModel.target === "react") {
    return { snapshot: HIDDEN_NATIVE_ISLAND_SNAPSHOT, snapshotKey: null };
  }
  return {
    snapshot: viewModel.snapshot,
    snapshotKey: nativeIslandSnapshotKey(viewModel.snapshot),
  };
}

export function readNativeIslandBridge(): NativeIslandBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const island = window.desktopBridge?.island;
  if (
    !island ||
    typeof island.getState !== "function" ||
    typeof island.updateSnapshot !== "function" ||
    typeof island.onState !== "function" ||
    typeof island.onAction !== "function"
  ) {
    return null;
  }
  return island;
}

export class NativeIslandRevisionGate {
  #desiredSnapshotKey: string | null = null;
  #publishedRevision: number | null = null;
  #bridgeState: NativeIslandBridgeState | null = null;

  setDesiredSnapshot(snapshotKey: string | null): void {
    if (snapshotKey === this.#desiredSnapshotKey) {
      return;
    }
    this.#desiredSnapshotKey = snapshotKey;
    this.#publishedRevision = null;
  }

  setPublishedRevision(snapshotKey: string | null, revision: number | null): void {
    if (snapshotKey !== this.#desiredSnapshotKey) {
      return;
    }
    this.#publishedRevision = revision;
  }

  setBridgeState(state: NativeIslandBridgeState | null): void {
    this.#bridgeState = state;
  }

  activeSnapshotKey(): string | null {
    if (
      !this.#desiredSnapshotKey ||
      this.#publishedRevision === null ||
      this.#bridgeState?.nativeActive !== true ||
      this.#bridgeState.renderedRevision !== this.#publishedRevision
    ) {
      return null;
    }
    return this.#desiredSnapshotKey;
  }
}

export function providerDecisionForNativeAction(
  kind: Exclude<NativeIslandAction["kind"], "open-thread">,
): ProviderApprovalDecision {
  switch (kind) {
    case "deny":
      return "decline";
    case "allow-once":
      return "accept";
    case "always-allow":
      return "acceptForSession";
  }
}

export class NativeIslandActionDispatcher {
  readonly #dependencies: NativeIslandActionDependencies;
  readonly #acceptedActionIds = new Set<string>();
  readonly #acceptedActionOrder: string[] = [];

  constructor(dependencies: NativeIslandActionDependencies) {
    this.#dependencies = dependencies;
  }

  async dispatch(action: NativeIslandAction, context: NativeIslandActionContext): Promise<boolean> {
    if (
      action.revision !== context.revision ||
      this.#acceptedActionIds.has(action.actionId) ||
      !this.#actionMatchesSnapshot(action, context.snapshot)
    ) {
      return false;
    }

    this.#rememberActionId(action.actionId);
    if (action.kind === "open-thread") {
      await this.#dependencies.openThread(action.threadId);
      return true;
    }

    await this.#dependencies.respondToApproval({
      threadId: action.threadId,
      requestId: action.requestId,
      decision: providerDecisionForNativeAction(action.kind),
    });
    return true;
  }

  #actionMatchesSnapshot(action: NativeIslandAction, snapshot: NativeIslandSnapshot): boolean {
    if (action.kind === "open-thread") {
      return snapshot.sessions.some((session) => session.id === action.threadId);
    }
    return (
      snapshot.mode === "approval" &&
      snapshot.approval.threadId === action.threadId &&
      snapshot.approval.requestId === action.requestId
    );
  }

  #rememberActionId(actionId: string): void {
    this.#acceptedActionIds.add(actionId);
    this.#acceptedActionOrder.push(actionId);
    if (this.#acceptedActionOrder.length <= MAX_REMEMBERED_ACTION_IDS) {
      return;
    }
    const expiredActionId = this.#acceptedActionOrder.shift();
    if (expiredActionId) {
      this.#acceptedActionIds.delete(expiredActionId);
    }
  }
}

export function NativeIslandCoordinator({
  viewModel,
  enabled,
  windowFocused,
  onNativeSnapshotActive,
}: NativeIslandCoordinatorProps) {
  const navigate = useNavigate();
  const bridge = readNativeIslandBridge();
  const gateRef = useRef(new NativeIslandRevisionGate());
  const publishedRef = useRef<PublishedNativeIslandSnapshot | null>(null);
  const publication = resolveNativeIslandPublication(viewModel, enabled, windowFocused);
  const desiredSnapshot = publication.snapshot;
  const desiredSnapshotKey = publication.snapshotKey;
  const desiredSnapshotRef = useRef<NativeIslandSnapshot>(desiredSnapshot);
  const desiredSnapshotKeyRef = useRef<string | null>(desiredSnapshotKey);
  desiredSnapshotRef.current = desiredSnapshot;
  desiredSnapshotKeyRef.current = desiredSnapshotKey;

  const dispatcher = useMemo(
    () =>
      new NativeIslandActionDispatcher({
        openThread: async (threadId) => {
          await navigate({ to: "/$threadId", params: { threadId } });
        },
        respondToApproval: async ({ threadId, requestId, decision }) => {
          const api = readNativeApi();
          if (!api) {
            return;
          }
          await api.orchestration.dispatchCommand({
            type: "thread.approval.respond",
            commandId: newCommandId(),
            threadId: ThreadId.makeUnsafe(threadId),
            requestId: ApprovalRequestId.makeUnsafe(requestId),
            decision,
            createdAt: new Date().toISOString(),
          });
        },
      }),
    [navigate],
  );

  useEffect(() => {
    const gate = gateRef.current;
    gate.setDesiredSnapshot(desiredSnapshotKey);
    publishedRef.current = null;
    onNativeSnapshotActive(null);
    if (!bridge) {
      gate.setBridgeState(null);
      return;
    }

    const snapshotToPublish = desiredSnapshotRef.current;
    let cancelled = false;
    void bridge
      .updateSnapshot(snapshotToPublish)
      .then((revision) => {
        if (cancelled) {
          return;
        }
        gate.setPublishedRevision(desiredSnapshotKey, revision);
        publishedRef.current =
          desiredSnapshotKey && revision !== null
            ? { key: desiredSnapshotKey, revision, snapshot: snapshotToPublish }
            : null;
        onNativeSnapshotActive(gate.activeSnapshotKey());
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        gate.setPublishedRevision(desiredSnapshotKey, null);
        publishedRef.current = null;
        onNativeSnapshotActive(null);
      });

    return () => {
      cancelled = true;
    };
  }, [bridge, desiredSnapshotKey, onNativeSnapshotActive]);

  useEffect(() => {
    if (!bridge) {
      onNativeSnapshotActive(null);
      return;
    }

    const gate = gateRef.current;
    const applyState = (state: NativeIslandBridgeState) => {
      gate.setBridgeState(state);
      onNativeSnapshotActive(gate.activeSnapshotKey());
    };
    let receivedPushedState = false;
    const unsubscribeState = bridge.onState((state) => {
      receivedPushedState = true;
      applyState(state);
    });
    const unsubscribeAction = bridge.onAction((action) => {
      const published = publishedRef.current;
      if (
        !published ||
        published.key !== desiredSnapshotKeyRef.current ||
        gate.activeSnapshotKey() !== published.key
      ) {
        return;
      }
      void dispatcher
        .dispatch(action, { revision: published.revision, snapshot: published.snapshot })
        .catch(() => undefined);
    });
    let cancelled = false;
    void bridge
      .getState()
      .then((state) => {
        if (!cancelled && !receivedPushedState) {
          applyState(state);
        }
      })
      .catch(() => {
        if (!cancelled && !receivedPushedState) {
          gate.setBridgeState(null);
          onNativeSnapshotActive(null);
        }
      });

    return () => {
      cancelled = true;
      unsubscribeState();
      unsubscribeAction();
    };
  }, [bridge, dispatcher, onNativeSnapshotActive]);

  useEffect(
    () => () => {
      if (bridge) {
        void bridge.updateSnapshot(HIDDEN_NATIVE_ISLAND_SNAPSHOT).catch(() => undefined);
      }
    },
    [bridge],
  );

  return null;
}
