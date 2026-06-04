// FILE: RuntimeEnvironmentControl.tsx
// Purpose: Thread-creation execution-target picker. Offers Local / Worktree /
// Remote and, when Remote is chosen, the advanced runtime-plan inputs (provider,
// resources, timeout, ports, persistence, egress, secrets). Local/Worktree
// delegate to the existing env-mode flow; Remote writes a `RuntimePlan` draft the
// creation flow reads. Default stays Local — opting into Remote is explicit.
// Layer: Web UI component (composer workspace control)

import type { ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { FiServer } from "react-icons/fi";
import { LuSplit } from "react-icons/lu";
import { CentralIcon } from "~/lib/central-icons";
import { ChevronDownIcon } from "~/lib/icons";
import { useRuntimePlanDraftStore } from "~/runtimePlanDraftStore";
import { cn } from "~/lib/utils";
import {
  EXECUTION_RUNTIME_PROVIDER_LABELS,
  EXECUTION_TARGET_LABELS,
  parsePortsInput,
  REMOTE_RUNTIME_PROVIDERS,
} from "~/lib/runtimePresentation";
import type { EnvMode } from "./BranchToolbar.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

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
  const draft = useRuntimePlanDraftStore((store) => store.draftByThreadId[threadId]);
  const setDraft = useRuntimePlanDraftStore((store) => store.setDraft);
  const remoteEnabled = draft?.enabled ?? false;
  const provider = draft?.provider ?? "fake";

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

  const triggerLabel = EXECUTION_TARGET_LABELS[selected];

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
        {triggerLabel}
        <ChevronDownIcon className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        side="top"
        sideOffset={6}
        className="w-72 [&_[data-slot=popover-viewport]]:py-0 [&_[data-slot=popover-viewport]]:[--viewport-inline-padding:0px]"
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
            <p className="pb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-foreground-secondary)]">
              Advanced
            </p>
            <div className="flex flex-col gap-2">
              <Field label="Provider">
                <select
                  value={provider}
                  onChange={(event) =>
                    setDraft(threadId, {
                      provider: event.target.value as (typeof REMOTE_RUNTIME_PROVIDERS)[number],
                    })
                  }
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-[length:var(--app-font-size-ui,12px)] text-foreground"
                >
                  {REMOTE_RUNTIME_PROVIDERS.map((value) => (
                    <option key={value} value={value}>
                      {EXECUTION_RUNTIME_PROVIDER_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="CPU">
                  <NumberInput
                    value={draft?.cpu ?? null}
                    placeholder="auto"
                    onChange={(cpu) => setDraft(threadId, { cpu })}
                  />
                </Field>
                <Field label="Memory (MB)">
                  <NumberInput
                    value={draft?.memoryMb ?? null}
                    placeholder="auto"
                    onChange={(memoryMb) => setDraft(threadId, { memoryMb })}
                  />
                </Field>
              </div>
              <Field label="Timeout (s)">
                <NumberInput
                  value={draft?.timeoutSeconds ?? null}
                  placeholder="provider default"
                  onChange={(timeoutSeconds) => setDraft(threadId, { timeoutSeconds })}
                />
              </Field>
              <Field label="Ports">
                <Input
                  size="sm"
                  defaultValue={(draft?.ports ?? []).join(", ")}
                  placeholder="3000, 8080"
                  onBlur={(event) =>
                    setDraft(threadId, { ports: parsePortsInput(event.currentTarget.value) })
                  }
                />
              </Field>
              <Field label="Egress allow-list">
                <Input
                  size="sm"
                  defaultValue={draft?.egressText ?? ""}
                  placeholder="example.com, api.internal"
                  onBlur={(event) => setDraft(threadId, { egressText: event.currentTarget.value })}
                />
              </Field>
              <ToggleRow
                label="Persistent"
                hint="Keep the runtime between turns"
                checked={draft?.persistent ?? false}
                onChange={(persistent) => setDraft(threadId, { persistent })}
              />
              <ToggleRow
                label="Forward secrets"
                hint="Pass configured secrets to the runtime"
                checked={draft?.forwardSecrets ?? false}
                onChange={(forwardSecrets) => setDraft(threadId, { forwardSecrets })}
              />
            </div>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-foreground-secondary)]">
      <span>{label}</span>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  placeholder,
  onChange,
}: {
  value: number | null;
  placeholder?: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <Input
      size="sm"
      type="number"
      min={1}
      defaultValue={value ?? ""}
      placeholder={placeholder}
      onBlur={(event) => {
        const raw = event.currentTarget.value.trim();
        if (raw.length === 0) {
          onChange(null);
          return;
        }
        const parsed = Number(raw);
        onChange(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
      }}
    />
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--color-text-foreground)]">
      <span className="flex flex-col">
        <span>{label}</span>
        <span className="text-[10px] text-[var(--color-text-foreground-secondary)]">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
