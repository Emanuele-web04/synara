// FILE: AppTourPreview.tsx
// Purpose: One small animated scene per app tour step, drawn inside the card's hero band
//          with the workspace's own glyphs and surface tokens. No live chats or provider
//          requests: sample titles reuse the onboarding stage's translated samples.
// Layer: Web UI illustration (aria-hidden through the band)
// Exports: AppTourPreview

import type { CSSProperties, ReactNode } from "react";

import { DIALOG_HERO_ITEM_SHADOW_CLASS_NAME } from "~/components/DialogHeroBand";
import { ProviderIcon } from "~/components/ProviderIcon";
import { useTranslation } from "~/i18n";
import {
  ArrowUpIcon,
  CheckIcon,
  ClockIcon,
  GitPullRequestIcon,
  InboxIcon,
  LoaderCircleIcon,
  TasksIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "../betaFeatures";
import type { AppTourStepId } from "./content";

const CARD_CLASS_NAME = cn(
  "rounded-xl border border-border bg-popover text-foreground",
  DIALOG_HERO_ITEM_SHADOW_CLASS_NAME,
);

export function AppTourPreview(props: { readonly step: AppTourStepId }) {
  return (
    <div className="scene-rise w-[248px]">
      {props.step === "newThread" ? <NewThreadPreview /> : null}
      {props.step === "activity" ? <ActivityPreview /> : null}
      {props.step === "tasks" ? <TasksPreview /> : null}
      {props.step === "inbox" ? <InboxPreview /> : null}
      {props.step === "pullRequests" ? <ReviewPreview /> : null}
    </div>
  );
}

function SkeletonLine(props: { readonly className?: string }) {
  return <span className={cn("block h-1.5 rounded-full bg-foreground/10", props.className)} />;
}

/** A composer whose agent picker cycles through the first three agents. */
function NewThreadPreview() {
  const agents = VISIBLE_PROVIDER_DESCRIPTORS.slice(0, 3);
  return (
    <div className={cn("flex flex-col gap-3 p-3", CARD_CLASS_NAME)}>
      <div className="flex flex-col gap-1.5 pt-0.5">
        <SkeletonLine className="w-4/5" />
        <SkeletonLine className="w-1/2" />
      </div>
      <div className="flex items-center gap-2">
        <span className="relative h-6 w-28 overflow-hidden rounded-full bg-secondary">
          {agents.map((agent, index) => (
            <span
              key={agent.kind}
              className="scene-cycle absolute inset-0 flex items-center gap-1.5 px-2 text-ui-timestamp font-medium"
              style={{ animationDelay: `${index * 1.6}s` }}
            >
              <ProviderIcon provider={agent.kind} className="size-3.5 shrink-0" />
              <span className="truncate">{agent.displayName}</span>
            </span>
          ))}
        </span>
        <span className="ms-auto flex size-6 items-center justify-center rounded-full bg-foreground text-background">
          <ArrowUpIcon className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

const SAMPLE_TASKS = [
  { key: "onboarding:stageTaskSeed", provider: "opencode" },
  { key: "onboarding:stageTaskRateLimit", provider: "codex" },
  { key: "onboarding:stageTaskFixAuth", provider: "claudeAgent" },
] as const;

function Row(props: {
  readonly leading: ReactNode;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  return (
    <span
      className={cn("flex items-center gap-2 rounded-lg px-2 py-1.5", props.className)}
      style={props.style}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">{props.leading}</span>
      <span className="min-w-0 flex-1 truncate text-ui-timestamp">{props.children}</span>
      {props.trailing}
    </span>
  );
}

/** Something waiting on you, something running that settles to done, something done. */
function ActivityPreview() {
  const { t } = useTranslation();
  const [waiting, running, done] = SAMPLE_TASKS;
  return (
    <div className={cn("flex flex-col gap-0.5 p-1.5", CARD_CLASS_NAME)}>
      <Row
        className="bg-warning/8 font-medium"
        leading={
          <span className="relative flex size-2">
            <span className="scene-halo absolute -inset-1 rounded-full border border-warning" />
            <span className="size-2 rounded-full bg-warning" />
          </span>
        }
        trailing={<ProviderIcon provider={waiting.provider} className="size-3 shrink-0" />}
      >
        {t(waiting.key)}
      </Row>
      <Row
        leading={
          <span className="relative flex size-3.5 items-center justify-center">
            <LoaderCircleIcon className="scene-settle-out absolute size-3.5 text-sky-500 motion-safe:animate-spin dark:text-sky-400" />
            <CheckIcon className="scene-settle-in absolute size-3.5 text-success" />
          </span>
        }
        trailing={<ProviderIcon provider={running.provider} className="size-3 shrink-0" />}
      >
        {t(running.key)}
      </Row>
      <Row
        className="text-muted-foreground"
        leading={<CheckIcon className="size-3.5 text-success" />}
        trailing={<ProviderIcon provider={done.provider} className="size-3 shrink-0" />}
      >
        {t(done.key)}
      </Row>
    </div>
  );
}

/** A to-do that ticks off, and one handed to an agent. */
function TasksPreview() {
  const { t } = useTranslation();
  const [first, second, third] = SAMPLE_TASKS;
  const box = "size-3.5 rounded-full border border-foreground/25";
  return (
    <div className={cn("flex flex-col gap-0.5 p-1.5", CARD_CLASS_NAME)}>
      <span className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-ui-timestamp font-medium text-muted-foreground">
        <TasksIcon className="size-3.5" />
        {t("chat:tasks")}
      </span>
      <Row
        leading={
          <span className="relative flex size-3.5">
            <span className={cn("absolute inset-0", box)} />
            <span className="scene-settle-in absolute inset-0 flex items-center justify-center rounded-full bg-success text-white">
              <CheckIcon className="size-2.5" />
            </span>
          </span>
        }
      >
        {t(third.key)}
      </Row>
      <Row
        className="bg-sky-500/8 dark:bg-sky-400/10"
        leading={<span className={box} />}
        trailing={
          <span className="relative flex size-4 items-center justify-center">
            <span className="scene-halo absolute -inset-1 rounded-full border border-sky-500 dark:border-sky-400" />
            <ProviderIcon provider={second.provider} className="size-3.5" />
          </span>
        }
      >
        {t(second.key)}
      </Row>
      <Row leading={<span className={box} />}>{t(first.key)}</Row>
    </div>
  );
}

/** Today's stack: tasks, a review request, and the recap, fanned and floating. */
function InboxPreview() {
  const cards = [
    {
      id: "today",
      icon: TasksIcon,
      tone: "text-sky-500 dark:text-sky-400",
      tilt: "-rotate-3",
      width: "w-3/4",
    },
    {
      id: "review",
      icon: GitPullRequestIcon,
      tone: "text-success",
      tilt: "rotate-0",
      width: "w-2/3",
    },
    { id: "recap", icon: ClockIcon, tone: "text-warning", tilt: "rotate-3", width: "w-1/2" },
  ] as const;
  return (
    <div className="flex items-center justify-center gap-2">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background">
        <InboxIcon className="size-4.5" />
      </span>
      {cards.map((card, index) => {
        const Icon = card.icon;
        return (
          <span
            key={card.id}
            className={cn("scene-rise", card.tilt)}
            style={{ animationDelay: `${120 + index * 110}ms` }}
          >
            <span
              className={cn("scene-float flex w-16 flex-col gap-2 p-2", CARD_CLASS_NAME)}
              style={{ animationDelay: `${index * -1.8}s` }}
            >
              <Icon className={cn("size-3.5", card.tone)} />
              <SkeletonLine className={card.width} />
              <SkeletonLine className="w-full" />
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** A pull request with its diff, and an agent review that settles to done. */
function ReviewPreview() {
  const { t } = useTranslation();
  return (
    <div className={cn("flex flex-col gap-1.5 p-2.5 text-ui-timestamp", CARD_CLASS_NAME)}>
      <span className="flex items-center gap-1.5 font-medium">
        <GitPullRequestIcon className="size-3.5 shrink-0 text-success" />
        <span className="truncate">{t("onboarding:dashboardPolish")}</span>
      </span>
      <span className="truncate rounded bg-success/10 px-1.5 py-0.5 text-success">
        {t("onboarding:addTheEmptyState")}
      </span>
      <span className="truncate rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">
        {t("onboarding:removeThePlaceholder")}
      </span>
      <span className="flex items-center gap-1.5 pt-0.5 text-muted-foreground">
        <ProviderIcon provider="claudeAgent" className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("onboarding:askAnAgentToReview")}</span>
        <span className="relative flex size-3 shrink-0 items-center justify-center">
          <LoaderCircleIcon className="scene-settle-out absolute size-3 motion-safe:animate-spin" />
          <CheckIcon className="scene-settle-in absolute size-3 text-success" />
        </span>
      </span>
    </div>
  );
}
