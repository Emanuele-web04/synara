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
  // Pulse while the instance is mid-transition (provisioning/starting/stopping)
  // so the chip reads as "working", not stalled. Honors reduced-motion.
  pending: "bg-warning animate-pulse motion-reduce:animate-none",
  idle: "bg-[var(--color-text-foreground-secondary)]",
  terminal: "bg-[var(--color-text-foreground-secondary)]",
  error: "bg-destructive",
};

const TONE_CHIP_CLASS: Record<RuntimeStatusTone, string> = {
  active: "border-sky-500/35 bg-sky-500/10 text-sky-700 hover:bg-sky-500/15 dark:text-sky-200",
  pending:
    "border-amber-500/35 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-200",
  idle: "border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)]",
  terminal:
    "border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)]",
  error: "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15",
};

// Refresh re-pulls the shell projection the client already owns. Stop/destroy/snapshot
// dispatch the `thread.runtime.action` client command, which the reactor routes
// to ExecutionRuntimeService for the runtime's recorded provider.
async function refreshRuntimeSnapshot(): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  const snapshot = await api.orchestration.getShellSnapshot();
  useStore.getState().syncServerShellSnapshot(snapshot);
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
          "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-1.5 text-[10px] font-medium transition-colors",
          TONE_CHIP_CLASS[presentation.tone],
          className,
        )}
        title={presentation.text}
        aria-label={presentation.text}
      >
        <FiServer className="size-3 shrink-0" />
        <span
          className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT_CLASS[presentation.tone])}
          aria-hidden
        />
        <span className="truncate">{presentation.label}</span>
        <span className="hidden truncate font-normal opacity-75 sm:inline">
          {presentation.statusLabel}
        </span>
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
