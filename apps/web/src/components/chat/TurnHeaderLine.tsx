// FILE: TurnHeaderLine.tsx
// Purpose: The line that opens a turn: "› Worked 20s · GPT-6 Luna · 22:33 ✓"
//          for a settled turn, "Working 12s" while it runs, with a hairline
//          running to the edge as the turn boundary.
// Layer: Web chat presentation component
// Exports: TurnHeaderLine, TurnModelChip
// Depends on: MessagesTimeline.logic header wording, ProviderIcon

import type { CSSProperties, ReactNode } from "react";

import type { TimestampFormat } from "../../appSettings";
import { formatProviderModelOptionName } from "../../providerModelOptions";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { BackgroundTrayIcon, CheckIcon, CircleAlertIcon, StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { ProviderIcon } from "../ProviderIcon";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import {
  formatTurnHeaderLabel,
  formatTurnResumedBy,
  type TurnHeader,
  type TurnModel,
  type TurnResumedBy,
} from "./MessagesTimeline.logic";
import { LiveElapsedTimer } from "./LiveElapsedTimer";

export function TurnModelChip({ model }: { model: TurnModel }) {
  const label = formatProviderModelOptionName({ provider: model.provider, slug: model.model });
  return (
    <span
      className="inline-flex max-w-[14rem] items-center gap-1 rounded-md bg-[var(--app-user-message-background)] px-1.5 py-px"
      data-turn-model-chip="true"
    >
      <ProviderIcon provider={model.provider} className="size-3 shrink-0" />
      <span className="truncate">{label || model.model}</span>
    </span>
  );
}

function Separator() {
  return <span aria-hidden>·</span>;
}

function OutcomeIcon({ outcome }: { outcome: TurnHeader["outcome"] }) {
  switch (outcome) {
    case "completed":
      return <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-300/90" />;
    case "stopped":
      return <StopIcon className="size-3 shrink-0" />;
    case "interrupted":
      return (
        <CircleAlertIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-300/90" />
      );
  }
}

// Wraps the label parts; the caller supplies the interactive shell (a
// disclosure trigger when the turn has folded work, a plain span otherwise).
function HeaderShell(props: {
  children: ReactNode;
  render?: ((content: ReactNode) => ReactNode) | undefined;
  fontSize: CSSProperties["fontSize"];
  dataState: string;
}) {
  const content = (
    <span className="inline-flex min-w-0 items-center gap-1.5">{props.children}</span>
  );
  return (
    <div
      className={cn("-ml-0.5 flex min-w-0 items-center gap-2 pb-2", MUTED_LABEL_TEXT_CLASS_NAME)}
      style={{ fontSize: props.fontSize }}
      data-turn-header={props.dataState}
    >
      {props.render ? props.render(content) : content}
      <div aria-hidden className="h-px min-w-6 flex-1 bg-border" />
    </div>
  );
}

export function TurnHeaderLine(
  props: {
    fontSize: CSSProperties["fontSize"];
    timestampFormat: TimestampFormat;
  } & (
    | {
        kind: "settled";
        header: TurnHeader;
        // Present when the turn has folded work: the header toggles it.
        disclosure?: {
          open: boolean;
          renderTrigger: (content: ReactNode) => ReactNode;
        };
      }
    | {
        kind: "live";
        startedAt: string;
        // Server-rendered/static surfaces pass a fixed clock.
        nowLabel?: string | null;
        modelChange?: TurnModel | null;
        resumedBy?: ReadonlyArray<TurnResumedBy> | null;
      }
  ),
) {
  if (props.kind === "live") {
    const resumedBy = props.resumedBy && props.resumedBy.length > 0 ? props.resumedBy : null;
    return (
      <HeaderShell fontSize={props.fontSize} dataState="live">
        {resumedBy ? <BackgroundTrayIcon className="size-3.5 shrink-0" /> : null}
        <span className="truncate">
          {resumedBy ? `Resumed: ${formatTurnResumedBy(resumedBy)} · ` : "Working "}
          <span className="tabular-nums">
            {props.nowLabel ?? <LiveElapsedTimer startedAt={props.startedAt} />}
          </span>
        </span>
        {props.modelChange ? (
          <>
            <Separator />
            <TurnModelChip model={props.modelChange} />
          </>
        ) : null}
      </HeaderShell>
    );
  }

  const { header, disclosure } = props;
  const resumed = header.outcome === "completed" && (header.resumedBy?.length ?? 0) > 0;
  const time = header.endedAt
    ? formatDayAwareTimestamp(header.endedAt, props.timestampFormat)
    : null;
  return (
    <HeaderShell
      fontSize={props.fontSize}
      dataState={header.outcome}
      render={disclosure?.renderTrigger}
    >
      {disclosure ? (
        <DisclosureChevron open={disclosure.open} className="text-muted-foreground/70" />
      ) : null}
      {resumed ? <BackgroundTrayIcon className="size-3.5 shrink-0" /> : null}
      <span className="truncate">{formatTurnHeaderLabel(header)}</span>
      {header.modelChange ? (
        <>
          <Separator />
          <TurnModelChip model={header.modelChange} />
        </>
      ) : null}
      {time ? (
        <>
          <Separator />
          <span className="shrink-0 tabular-nums">{time}</span>
        </>
      ) : null}
      <OutcomeIcon outcome={header.outcome} />
    </HeaderShell>
  );
}
