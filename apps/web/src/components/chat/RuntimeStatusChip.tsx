// FILE: RuntimeStatusChip.tsx
// Purpose: Header control showing "Runtime: <provider> · <status>" for threads
// that run on a remote execution runtime, opening an infra panel (processes,
// routes, leases, snapshots, actions). Hidden for local/worktree threads.
// Layer: Chat shell header control

import type { ExecutionInstanceId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationThreadRuntime } from "@t3tools/contracts";
import { useState } from "react";
import { FiServer } from "react-icons/fi";
import { RuntimePanel } from "../RuntimePanel";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { cn, newCommandId } from "~/lib/utils";
import {
  resolveRuntimeHeaderPresentation,
  type RuntimeActionKind,
  type RuntimeStatusTone,
} from "~/lib/runtimePresentation";

interface RuntimeStatusChipProps {
  runtime: OrchestrationThreadRuntime | null | undefined;
  threadId: ThreadId;
  className?: string;
}

const TONE_DOT_CLASS: Record<RuntimeStatusTone, string> = {
  active: "bg-success",
  pending: "bg-warning",
  idle: "bg-[var(--color-text-foreground-secondary)]",
  terminal: "bg-[var(--color-text-foreground-secondary)]",
  error: "bg-destructive",
};

// Refresh re-pulls the read-model the client already owns. Stop/destroy/snapshot
// dispatch the `thread.runtime.action` client command, which the reactor routes
// to ExecutionRuntimeService for the runtime's recorded provider.
async function refreshRuntimeSnapshot(): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  const snapshot = await api.orchestration.getSnapshot();
  useStore.getState().syncServerReadModel(snapshot);
}

async function dispatchRuntimeLifecycleAction(
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  action: "stop" | "destroy" | "snapshot",
): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  await api.orchestration.dispatchCommand({
    type: "thread.runtime.action",
    commandId: newCommandId(),
    threadId,
    action,
    instanceId,
    createdAt: new Date().toISOString(),
  });
}

export function RuntimeStatusChip({ runtime, threadId, className }: RuntimeStatusChipProps) {
  const [open, setOpen] = useState(false);
  const presentation = resolveRuntimeHeaderPresentation(runtime);
  if (!presentation.show) {
    return null;
  }
  const onRuntimeAction = (kind: RuntimeActionKind) => {
    if (kind === "refresh") {
      void refreshRuntimeSnapshot();
      return;
    }
    const instanceId = runtime?.instance?.id;
    if (instanceId === undefined) {
      return;
    }
    void dispatchRuntimeLifecycleAction(threadId, instanceId, kind);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] px-1.5 text-[10px] font-normal text-[var(--color-text-foreground-secondary)] transition-colors hover:bg-[var(--color-background-button-secondary-hover)]",
          className,
        )}
        title={presentation.text}
      >
        <FiServer className="size-3 shrink-0" />
        <span
          className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT_CLASS[presentation.tone])}
          aria-hidden
        />
        <span className="truncate">{presentation.providerLabel}</span>
        <span className="truncate opacity-70">{presentation.statusLabel}</span>
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-80 [&_[data-slot=popover-viewport]]:p-0"
      >
        <RuntimePanel
          runtime={runtime}
          onRuntimeAction={onRuntimeAction}
          className="rounded-none border-0"
        />
      </PopoverPopup>
    </Popover>
  );
}
