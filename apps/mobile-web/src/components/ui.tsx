import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChevronRight,
  IconCircleCheck,
  IconClock,
  IconLoader2,
  IconPlayerStop,
  IconRobot,
  IconSparkles,
} from "@tabler/icons-react";
import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ThreadStatus, ThreadSummary } from "../domain";
import { relativeTime, statusLabel } from "../lib/mobileLogic";

export function ScreenHeader({
  title,
  eyebrow,
  back,
  actions,
}: {
  readonly title: string;
  readonly eyebrow?: string;
  readonly back?: boolean;
  readonly actions?: ReactNode;
}) {
  const router = useRouter();
  return (
    <header className="screen-header">
      <div className="screen-header__row">
        {back ? (
          <button type="button" className="icon-button" aria-label="Go back" onClick={() => router.history.back()}>
            <IconArrowLeft aria-hidden="true" size={22} stroke={1.8} />
          </button>
        ) : (
          <div className="brand-mark" aria-hidden="true">
            <IconSparkles size={18} stroke={1.8} />
          </div>
        )}
        <div className="screen-header__titles">
          {eyebrow ? <p>{eyebrow}</p> : null}
          <h1>{title}</h1>
        </div>
        {actions ? <div className="screen-header__actions">{actions}</div> : null}
      </div>
    </header>
  );
}

export function SectionHeading({
  title,
  count,
  action,
}: {
  readonly title: string;
  readonly count?: number;
  readonly action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {typeof count === "number" ? <span className="count-badge">{count}</span> : null}
      {action ? <div className="section-heading__action">{action}</div> : null}
    </div>
  );
}

export function StatusBadge({ status }: { readonly status: ThreadStatus }) {
  return (
    <span className="status-badge" data-status={status}>
      <StatusIcon status={status} />
      {statusLabel(status)}
    </span>
  );
}

function StatusIcon({ status }: { readonly status: ThreadStatus }) {
  const props = { "aria-hidden": true as const, size: 13, stroke: 2 };
  switch (status) {
    case "running":
      return <IconLoader2 {...props} className="spin" />;
    case "waiting-approval":
    case "waiting-input":
    case "failed":
      return <IconAlertTriangle {...props} />;
    case "completed":
      return <IconCircleCheck {...props} />;
    case "interrupted":
      return <IconPlayerStop {...props} />;
    default:
      return <IconClock {...props} />;
  }
}

export function ThreadRow({ thread }: { readonly thread: ThreadSummary }) {
  return (
    <Link
      to="/threads/$threadId"
      params={{ threadId: thread.id }}
      className="thread-row touch-row"
    >
      <div className="thread-row__icon" data-status={thread.status}>
        <IconRobot aria-hidden="true" size={18} stroke={1.8} />
      </div>
      <div className="thread-row__content">
        <div className="thread-row__topline">
          <h3>{thread.title}</h3>
          <time dateTime={thread.updatedAt}>{relativeTime(thread.updatedAt)}</time>
        </div>
        <p>{thread.summary ?? `${thread.providerLabel} · ${thread.modelLabel}`}</p>
        <StatusBadge status={thread.status} />
      </div>
      <IconChevronRight className="row-chevron" aria-hidden="true" size={18} stroke={1.6} />
    </Link>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon">{icon}</div> : null}
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function LoadingBlock({ label = "Loading" }: { readonly label?: string }) {
  return (
    <div className="loading-block" role="status">
      <IconLoader2 className="spin" aria-hidden="true" size={20} />
      <span>{label}</span>
    </div>
  );
}

export function InlineError({ children }: { readonly children: ReactNode }) {
  return (
    <div className="inline-error" role="alert">
      <IconAlertTriangle aria-hidden="true" size={18} />
      <span>{children}</span>
    </div>
  );
}
