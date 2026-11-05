// FILE: StageIllustrations.tsx
// Purpose: The product scenes behind the onboarding's feature steps: parallel tasks with a
//          diff and browser check ("tasks"), and an approval answered from the iPhone
//          ("pocket"). Decorative faux UI drawn on a fixed canvas that FitStage scales.
// Layer: Web UI illustration (aria-hidden)

import type { ProviderKind } from "@synara/contracts";
import type { ReactNode } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { useTranslation } from "~/i18n";
import { CheckIcon, CircleCheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  IPHONE_HEIGHT,
  IPHONE_WIDTH,
  IosInboxScreen,
  IosNotificationBanner,
  IphoneMock,
} from "./IphoneMock";
import { ONBOARDING_LIVE_COLOR, ONBOARDING_STAGE_CARD_CLASS_NAME } from "./stageTokens";

export const TASKS_STAGE_SIZE = { width: 1000, height: 400 } as const;
export const POCKET_STAGE_SIZE = { width: 1000, height: 480 } as const;

function WindowDots() {
  return (
    <span className="flex gap-1.5">
      {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
        <span key={color} className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
      ))}
    </span>
  );
}

function Positioned(props: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height?: number;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn("absolute", props.className)}
      style={{ left: props.x, top: props.y, width: props.width, height: props.height }}
    >
      {props.children}
    </div>
  );
}

/** Sample data shown inside the illustrations: code, paths and names stay untranslated. */
const SAMPLE_PROJECT = "synara-web";
const SAMPLE_URL = "localhost:3000/login";
const SAMPLE_DIFF_FILE = "src/auth/callback.ts";
const SAMPLE_APPROVAL_COMMAND = "$ bun run db:migrate --env staging";
const SEED_TASK_TITLE = "onboarding:stageTaskSeed";

const TASKS: ReadonlyArray<{
  title: string;
  provider: ProviderKind;
  agent: string;
  branch: string;
  status: "ready" | "running" | "ask";
  /** Running time, for tasks still running. */
  minutes?: number;
}> = [
  {
    title: "onboarding:stageTaskFixAuth",
    provider: "claudeAgent",
    agent: "Claude Code",
    branch: "fix-auth",
    status: "ready",
  },
  {
    title: "onboarding:stageTaskRateLimit",
    provider: "codex",
    agent: "Codex",
    branch: "rate-limit",
    status: "running",
    minutes: 2,
  },
  {
    title: "onboarding:stageTaskPostgres",
    provider: "cursor",
    agent: "Cursor",
    branch: "pg17",
    status: "running",
    minutes: 6,
  },
  {
    title: SEED_TASK_TITLE,
    provider: "opencode",
    agent: "OpenCode",
    branch: "seed",
    status: "ask",
  },
];

const DIFF_LINES: ReadonlyArray<{ kind: "context" | "removed" | "added"; text: string }> = [
  { kind: "context", text: "const params = new URL(req.url).searchParams" },
  { kind: "removed", text: 'if (params.get("state") !== session.state) {' },
  { kind: "added", text: 'const state = decodeURIComponent(params.get("state"))' },
  { kind: "added", text: "if (state !== session.state) {" },
  { kind: "context", text: '  return redirect("/login?error=state")' },
  { kind: "context", text: "}" },
];

/** Step "tasks": four agents in parallel worktrees, one diff, one browser check. */
export function TasksIllustration() {
  const { t } = useTranslation();
  return (
    <div aria-hidden className="relative size-full">
      {/* Browser check, behind the diff. */}
      <Positioned x={575} y={0} width={420} height={290}>
        <div
          className={cn(
            "flex size-full flex-col overflow-hidden",
            ONBOARDING_STAGE_CARD_CLASS_NAME,
          )}
        >
          <div className="flex items-center gap-3 border-b border-foreground/8 px-3 py-2">
            <span className="flex gap-1.5">
              {[0, 1, 2].map((dot) => (
                <span key={dot} className="size-2.5 rounded-full bg-foreground/15" />
              ))}
            </span>
            <span className="flex-1 truncate rounded-md bg-foreground/5 px-2.5 py-1 font-mono text-ui-xs text-muted-foreground">
              {SAMPLE_URL}
            </span>
          </div>
          <div className="relative flex flex-1 flex-col items-center justify-center gap-2.5 ps-40">
            <span className="size-7 rounded-lg bg-foreground" />
            <span className="h-7 w-40 rounded-md border border-foreground/12" />
            <span className="h-7 w-40 rounded-md border border-foreground/12" />
            <span className="h-7 w-40 rounded-md bg-foreground" />
            <span
              className="absolute right-4 bottom-16 flex items-center gap-1 rounded-full px-2.5 py-1 text-ui-xs text-white shadow-[0_6px_16px_-6px_rgb(49_124_255/0.8)]"
              style={{ backgroundColor: ONBOARDING_LIVE_COLOR }}
            >
              <CheckIcon className="size-3" />
              {t("onboarding:stageLoginWorks")}
            </span>
          </div>
        </div>
      </Positioned>

      {/* Task list. */}
      <Positioned x={0} y={45} width={300}>
        <div className={cn("flex flex-col gap-1 p-3", ONBOARDING_STAGE_CARD_CLASS_NAME)}>
          <div className="flex items-center gap-3 px-1 pb-2">
            <WindowDots />
          </div>
          <span className="px-2 pb-1 text-ui-sm text-muted-foreground">
            {t("onboarding:stageProjectRunning", { project: SAMPLE_PROJECT, count: 4 })}
          </span>
          {TASKS.map((task, index) => (
            <div
              key={task.title}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2 py-2",
                index === 0 && "bg-foreground/5",
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {task.status === "ready" ? (
                  <CircleCheckIcon className="size-4 text-success" />
                ) : task.status === "ask" ? (
                  <TriangleAlertIcon className="size-4 text-warning" />
                ) : (
                  <LoaderCircleIcon
                    className="size-4 motion-safe:animate-spin"
                    style={{ color: ONBOARDING_LIVE_COLOR }}
                  />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui text-foreground">{t(task.title)}</span>
                <span className="flex items-center gap-1 font-mono text-ui-xs text-muted-foreground">
                  <ProviderIcon provider={task.provider} className="size-3" />
                  {task.agent} · {task.branch}
                </span>
              </span>
              <span
                className={cn(
                  "font-mono text-ui-xs",
                  task.status === "ready"
                    ? "text-success"
                    : task.status === "ask"
                      ? "text-warning"
                      : "text-muted-foreground",
                )}
              >
                {task.status === "ready"
                  ? t("onboarding:stageStatusReady")
                  : task.status === "ask"
                    ? t("onboarding:stageStatusAsk")
                    : t("onboarding:stageMinutes", { count: task.minutes ?? 0 })}
              </span>
            </div>
          ))}
        </div>
      </Positioned>

      {/* The diff of the finished task. */}
      <Positioned x={310} y={78} width={440}>
        <div className={cn("flex flex-col overflow-hidden", ONBOARDING_STAGE_CARD_CLASS_NAME)}>
          <div className="flex items-center justify-between border-b border-foreground/8 px-4 py-3">
            <span className="font-mono text-ui-sm text-foreground">{SAMPLE_DIFF_FILE}</span>
            <span className="font-mono text-ui-xs">
              <span className="text-success">+18</span> <span className="text-destructive">−7</span>
            </span>
          </div>
          <div className="flex flex-col py-2 font-mono text-ui-xs">
            {DIFF_LINES.map((line) => (
              <span
                key={`${line.kind}:${line.text}`}
                className={cn(
                  "truncate px-4 py-0.5 whitespace-pre",
                  line.kind === "removed" && "bg-destructive/8 text-destructive",
                  line.kind === "added" && "bg-success/8 text-success",
                  line.kind === "context" && "text-muted-foreground",
                )}
              >
                {line.kind === "removed" ? "- " : line.kind === "added" ? "+ " : "  "}
                {line.text}
              </span>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-foreground/8 px-4 py-2.5">
            <span className="text-ui-sm text-muted-foreground">
              {t("onboarding:stageTestsPassed", { count: 24 })}
            </span>
            <span className="rounded-lg bg-foreground px-3 py-1.5 text-ui-sm text-background">
              {t("onboarding:stageOpenPr")}
            </span>
          </div>
        </div>
      </Positioned>
    </div>
  );
}

const POCKET_PHONE_SCALE = 0.8;

/** Step "pocket": the same approval on this computer and on the iPhone. */
export function PocketIllustration(props: { readonly host: string }) {
  const { t } = useTranslation();
  return (
    <div aria-hidden className="relative size-full">
      <Positioned x={20} y={150} width={460}>
        <div className={cn("flex flex-col", ONBOARDING_STAGE_CARD_CLASS_NAME)}>
          <div className="flex items-center gap-3 border-b border-foreground/8 px-4 py-3">
            <WindowDots />
            <span className="text-ui text-foreground">{t(SEED_TASK_TITLE)}</span>
            <span className="flex items-center gap-1 font-mono text-ui-xs text-muted-foreground">
              <ProviderIcon provider="opencode" className="size-3" />
              OpenCode
            </span>
          </div>
          <div className="flex flex-col gap-3 p-4">
            <p className="text-ui text-foreground">{t("onboarding:stageAgentMessage")}</p>
            <div className="flex flex-col gap-2.5 rounded-xl border border-warning/25 bg-warning/6 p-3.5">
              <span className="text-ui-sm font-medium text-warning">
                {t("automation:approval_needed")}
              </span>
              <code className="font-mono text-ui-sm text-foreground">
                {SAMPLE_APPROVAL_COMMAND}
              </code>
              <span className="flex gap-2">
                <span className="rounded-lg bg-foreground px-3 py-1.5 text-ui-sm text-background">
                  {t("automation:approval_approve")}
                </span>
                <span className="rounded-lg border border-foreground/12 px-3 py-1.5 text-ui-sm text-foreground">
                  {t("common:deny")}
                </span>
              </span>
            </div>
          </div>
        </div>
      </Positioned>

      <svg
        className="absolute"
        style={{ left: 480, top: 280, width: 140, height: 2 }}
        viewBox="0 0 140 2"
      >
        <line
          x1="0"
          y1="1"
          x2="140"
          y2="1"
          stroke={ONBOARDING_LIVE_COLOR}
          strokeOpacity="0.5"
          strokeDasharray="3 4"
        />
      </svg>

      <Positioned x={492} y={268} width={110} className="flex justify-center">
        <span
          className="rounded-full border bg-background px-2.5 py-1 font-mono text-ui-xs"
          style={{ borderColor: `${ONBOARDING_LIVE_COLOR}66`, color: ONBOARDING_LIVE_COLOR }}
        >
          {t("onboarding:stageRemote")}
        </span>
      </Positioned>

      <div
        className="absolute origin-top-left"
        style={{
          left: 640,
          top: 40,
          width: IPHONE_WIDTH,
          height: IPHONE_HEIGHT,
          transform: `scale(${POCKET_PHONE_SCALE})`,
        }}
      >
        <IphoneMock>
          <IosInboxScreen
            host={props.host}
            needsYou={1}
            banner={
              <IosNotificationBanner
                title={t("onboarding:stageBannerTitle", { task: t(SEED_TASK_TITLE) })}
                body={t("onboarding:stageBannerBody")}
              />
            }
          />
        </IphoneMock>
      </div>
    </div>
  );
}
