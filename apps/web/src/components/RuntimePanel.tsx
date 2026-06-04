// FILE: RuntimePanel.tsx
// Purpose: Infra-focused execution-runtime panel for a thread — instance status,
// processes, exposed routes, activity leases, snapshots, and lifecycle actions.
// Reads the public runtime read-model (`OrchestrationThread.runtime`). Provider-
// session/agent UX stays elsewhere; this panel is deliberately infrastructure-only.
// Layer: Web UI component

import type {
  OrchestrationThreadRuntime,
  RuntimeActivityLeaseSummary,
  RuntimeProcessSummary,
  RuntimeRouteSummary,
  RuntimeSnapshotSummary,
} from "@t3tools/contracts";
import { FiCpu, FiServer } from "react-icons/fi";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ExternalLinkIcon, RefreshCwIcon, StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  EXECUTION_RUNTIME_PROVIDER_LABELS,
  RUNTIME_ACTION_LABELS,
  RUNTIME_INSTANCE_STATUS_LABELS,
  type RuntimeActionKind,
  type RuntimeStatusTone,
  resolveRuntimeActions,
  resolveRuntimeStatusTone,
} from "~/lib/runtimePresentation";

interface RuntimePanelProps {
  runtime: OrchestrationThreadRuntime | null | undefined;
  /** Invoked by an enabled action (stop/destroy/snapshot/refresh). */
  onRuntimeAction?: (kind: RuntimeActionKind) => void;
  className?: string;
}

const TONE_BADGE_VARIANT: Record<
  RuntimeStatusTone,
  "default" | "success" | "warning" | "error" | "secondary"
> = {
  active: "success",
  pending: "warning",
  idle: "secondary",
  terminal: "secondary",
  error: "error",
};

function StatusBadge({ runtime }: { runtime: OrchestrationThreadRuntime }) {
  const tone = resolveRuntimeStatusTone(runtime.status);
  return (
    <Badge variant={TONE_BADGE_VARIANT[tone]} size="sm" className="shrink-0">
      {RUNTIME_INSTANCE_STATUS_LABELS[runtime.status]}
    </Badge>
  );
}

const PROCESS_STATUS_LABEL: Record<RuntimeProcessSummary["status"], string> = {
  starting: "Starting",
  running: "Running",
  exited: "Exited",
  failed: "Failed",
};

function ProcessRow({ process }: { process: RuntimeProcessSummary }) {
  const failed = process.status === "failed";
  return (
    <li className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
      <span className="flex min-w-0 items-center gap-2">
        <FiCpu className="size-3.5 shrink-0 text-[var(--color-text-foreground-secondary)]" />
        <span
          className="min-w-0 truncate font-mono text-[11px]"
          title={process.command ?? undefined}
        >
          {process.command ?? process.role}
        </span>
        <Badge variant="outline" size="sm" className="shrink-0">
          {process.role}
        </Badge>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {process.exitCode !== null && process.exitCode !== undefined ? (
          <span className="tabular-nums text-[var(--color-text-foreground-secondary)]">
            exit {process.exitCode}
          </span>
        ) : null}
        <span
          className={cn(
            "text-[var(--color-text-foreground-secondary)]",
            failed && "text-destructive",
          )}
        >
          {PROCESS_STATUS_LABEL[process.status]}
        </span>
      </span>
    </li>
  );
}

function RouteRow({ route }: { route: RuntimeRouteSummary }) {
  return (
    <li className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
      <span className="flex min-w-0 items-center gap-2">
        <span className="tabular-nums text-[var(--color-text-foreground-secondary)]">
          :{route.port}
        </span>
        {route.label ? (
          <span className="min-w-0 truncate text-[var(--color-text-foreground)]">
            {route.label}
          </span>
        ) : null}
      </span>
      {route.url ? (
        <a
          href={route.url}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-info-foreground hover:underline"
        >
          <span className="max-w-40 truncate">{route.url}</span>
          <ExternalLinkIcon className="size-3" />
        </a>
      ) : (
        <span className="text-[var(--color-text-foreground-secondary)]">no URL</span>
      )}
    </li>
  );
}

function LeaseRow({ lease }: { lease: RuntimeActivityLeaseSummary }) {
  return (
    <li className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
      <Badge variant="outline" size="sm" className="shrink-0">
        {lease.reason}
      </Badge>
      <span className="text-[var(--color-text-foreground-secondary)]">
        {lease.expiresAt ? `expires ${new Date(lease.expiresAt).toLocaleTimeString()}` : "active"}
      </span>
    </li>
  );
}

function SnapshotRow({ snapshot }: { snapshot: RuntimeSnapshotSummary }) {
  return (
    <li className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
      <span className="min-w-0 truncate text-[var(--color-text-foreground)]">
        {snapshot.label ?? snapshot.id}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[var(--color-text-foreground-secondary)]">
        {snapshot.secretTainted ? (
          <Badge variant="warning" size="sm">
            secret-tainted
          </Badge>
        ) : null}
        {new Date(snapshot.createdAt).toLocaleDateString()}
      </span>
    </li>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-[color:var(--color-border-light)]">
      <h4 className="flex items-center gap-2 px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-foreground-secondary)]">
        {title}
        <span className="tabular-nums opacity-70">{count}</span>
      </h4>
      {count > 0 ? (
        <ul className="pb-1">{children}</ul>
      ) : (
        <p className="px-3 pb-2 text-xs text-[var(--color-text-foreground-secondary)]">None</p>
      )}
    </section>
  );
}

const ACTION_ICON: Partial<Record<RuntimeActionKind, React.ReactNode>> = {
  stop: <StopIcon className="size-3.5" />,
  refresh: <RefreshCwIcon className="size-3.5" />,
};

/**
 * Infra panel for a thread's execution runtime. Renders nothing for
 * local/worktree threads — those keep the existing workspace chrome and have no
 * remote infrastructure to manage.
 */
export function RuntimePanel({ runtime, onRuntimeAction, className }: RuntimePanelProps) {
  if (!runtime || runtime.targetKind !== "remote-runtime") {
    return null;
  }
  const actions = resolveRuntimeActions(runtime);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <FiServer className="size-4 shrink-0 text-[var(--color-text-foreground-secondary)]" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-[var(--color-text-foreground)]">
              {EXECUTION_RUNTIME_PROVIDER_LABELS[runtime.provider]}
            </span>
            {runtime.instance?.rootPath ? (
              <span
                className="block truncate font-mono text-[10px] text-[var(--color-text-foreground-secondary)]"
                title={runtime.instance.rootPath}
              >
                {runtime.instance.rootPath}
              </span>
            ) : null}
          </span>
        </span>
        <StatusBadge runtime={runtime} />
      </div>

      {runtime.instance?.failureReason ? (
        <p className="border-t border-[color:var(--color-border-light)] bg-destructive/8 px-3 py-1.5 text-xs text-destructive-foreground">
          {runtime.instance.failureReason}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 border-t border-[color:var(--color-border-light)] px-3 py-2">
        {actions.map((action) => (
          <Button
            key={action.kind}
            size="sm"
            variant={action.kind === "destroy" ? "destructive" : "chrome"}
            disabled={!action.enabled}
            title={action.disabledReason ?? undefined}
            className="gap-1.5"
            onClick={() => {
              if (action.enabled) {
                onRuntimeAction?.(action.kind);
              }
            }}
          >
            {ACTION_ICON[action.kind] ?? null}
            {RUNTIME_ACTION_LABELS[action.kind]}
          </Button>
        ))}
      </div>

      <Section title="Processes" count={runtime.processes.length}>
        {runtime.processes.map((process) => (
          <ProcessRow key={process.id} process={process} />
        ))}
      </Section>
      <Section title="Routes" count={runtime.routes.length}>
        {runtime.routes.map((route) => (
          <RouteRow key={route.id} route={route} />
        ))}
      </Section>
      <Section title="Leases" count={runtime.leases.length}>
        {runtime.leases.map((lease) => (
          <LeaseRow key={lease.id} lease={lease} />
        ))}
      </Section>
      <Section title="Snapshots" count={runtime.snapshots.length}>
        {runtime.snapshots.map((snapshot) => (
          <SnapshotRow key={snapshot.id} snapshot={snapshot} />
        ))}
      </Section>
    </div>
  );
}
