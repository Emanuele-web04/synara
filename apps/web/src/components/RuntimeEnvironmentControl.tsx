// FILE: RuntimeEnvironmentControl.tsx
// Purpose: Thread-creation execution-target picker. Offers Local / Worktree /
// Remote. Remote is a plain opt-in — the runtime is provisioned from the
// workspace-level Sandboxes settings (provider, snapshot, resources), so the
// composer stays a target picker rather than an infra form. Local/Worktree
// delegate to the existing env-mode flow. Default stays Local.
// Layer: Web UI component (composer workspace control)

import type { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { FiServer } from "react-icons/fi";
import { LuSplit } from "react-icons/lu";
import { CentralIcon } from "~/lib/central-icons";
import { ArrowRightIcon, ChevronDownIcon } from "~/lib/icons";
import { useRuntimePlanDraftStore } from "~/runtimePlanDraftStore";
import { cn } from "~/lib/utils";
import { EXECUTION_TARGET_LABELS } from "~/lib/runtimePresentation";
import type { EnvMode } from "./BranchToolbar.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

interface RuntimeEnvironmentControlProps {
  /** The draft thread the runtime plan is being authored for. */
  threadId: ThreadId;
  /** Current local/worktree env mode resolved by the workspace controls. */
  effectiveEnvMode: EnvMode;
  /** Whether worktree is an offered option (matches the env picker's gate). */
  canSelectWorktree: boolean;
  onSelectLocal: () => void;
  onSelectWorktree: () => void;
  className?: string;
}

type SelectedTarget = "local" | "worktree" | "remote-runtime";

function WorktreeGlyph({ className }: { className?: string }) {
  return <LuSplit className={cn("rotate-90", className)} />;
}

export function RuntimeEnvironmentControl({
  threadId,
  effectiveEnvMode,
  canSelectWorktree,
  onSelectLocal,
  onSelectWorktree,
  className,
}: RuntimeEnvironmentControlProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const draft = useRuntimePlanDraftStore((store) => store.draftByThreadId[threadId]);
  const setDraft = useRuntimePlanDraftStore((store) => store.setDraft);
  const remoteEnabled = draft?.enabled ?? false;

  const selected: SelectedTarget = remoteEnabled ? "remote-runtime" : effectiveEnvMode;

  const selectLocal = () => {
    setDraft(threadId, { enabled: false });
    onSelectLocal();
    setOpen(false);
  };
  const selectWorktree = () => {
    setDraft(threadId, { enabled: false });
    onSelectWorktree();
    setOpen(false);
  };
  const selectRemote = () => {
    setDraft(threadId, { enabled: true });
  };

  const openSandboxSettings = () => {
    setOpen(false);
    void navigate({
      to: "/settings",
      search: (previous) => ({ ...previous, section: "sandboxes" }),
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[length:var(--app-font-size-ui-xs,10px)] font-normal text-[var(--color-text-foreground-secondary)] transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)]",
          className,
        )}
      >
        {selected === "remote-runtime" ? (
          <FiServer className="size-3.5" />
        ) : selected === "worktree" ? (
          <WorktreeGlyph className="size-3.5" />
        ) : (
          <CentralIcon name="macbook" className="size-3.5" />
        )}
        {EXECUTION_TARGET_LABELS[selected]}
        <ChevronDownIcon className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        side="top"
        sideOffset={6}
        className="w-64 [&_[data-slot=popover-viewport]]:py-0 [&_[data-slot=popover-viewport]]:[--viewport-inline-padding:0px]"
      >
        <div className="py-1.5">
          <p className="px-3 pb-1 pt-1 text-[11px] font-medium text-[var(--color-text-foreground-secondary)]">
            Environment
          </p>
          <TargetOption
            label={EXECUTION_TARGET_LABELS.local}
            icon={
              <CentralIcon
                name="macbook"
                className="size-4 text-[var(--color-text-foreground-secondary)]"
              />
            }
            selected={selected === "local"}
            onSelect={selectLocal}
          />
          {canSelectWorktree || selected === "worktree" ? (
            <TargetOption
              label={EXECUTION_TARGET_LABELS.worktree}
              icon={
                <WorktreeGlyph className="size-4 text-[var(--color-text-foreground-secondary)]" />
              }
              selected={selected === "worktree"}
              onSelect={selectWorktree}
            />
          ) : null}
          <TargetOption
            label={EXECUTION_TARGET_LABELS["remote-runtime"]}
            icon={<FiServer className="size-4 text-[var(--color-text-foreground-secondary)]" />}
            selected={selected === "remote-runtime"}
            onSelect={selectRemote}
          />
        </div>

        {remoteEnabled ? (
          <div className="border-t border-[color:var(--color-border-light)] px-3 py-2">
            <p className="text-[11px] leading-snug text-[var(--color-text-foreground-secondary)]">
              Provisions from your Sandboxes settings — provider, snapshot, and resources.
            </p>
            <button
              type="button"
              onClick={openSandboxSettings}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-foreground)] transition-colors hover:text-[var(--color-text-link,var(--color-text-foreground))]"
            >
              Configure remote defaults
              <ArrowRightIcon className="size-3" />
            </button>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function TargetOption({
  label,
  icon,
  selected,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-elevated-secondary)]"
      onClick={onSelect}
    >
      {icon}
      <span>{label}</span>
      {selected ? (
        <svg
          className="ml-auto size-4 text-[var(--color-text-foreground)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : null}
    </button>
  );
}
