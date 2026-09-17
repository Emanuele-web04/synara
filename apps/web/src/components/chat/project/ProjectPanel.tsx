import type { ModelSelection, ProjectId, ThreadId } from "@synara/contracts";
import { PROJECT_CONTEXT_PREVIEW_DOCUMENTS } from "@synara/shared/projectAgent";
import { useEffect, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { FolderClosed } from "~/components/FolderClosed";
import { Button } from "~/components/ui/button";
import { IconButton } from "~/components/ui/icon-button";
import { Textarea } from "~/components/ui/textarea";
import { AUXILIARY_PANEL_MOTION_CLASS } from "~/components/chat/auxiliary/ChatAuxiliaryPanel";
import { ENVIRONMENT_PANEL_SURFACE_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME } from "~/components/chat/environment/environmentPanelStyles";
import { basenameOfPath } from "~/file-icons";
import { BotIcon, PauseIcon, PlayIcon, SettingsIcon, WorkflowIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentCollapsibleSection,
  EnvironmentPanelTitle,
  EnvironmentRow,
  EnvironmentSectionDivider,
  EnvironmentSectionLabel,
} from "../environment/EnvironmentRow";
import { ProjectAgentDialog } from "./ProjectAgentDialog";
import { defaultProjectAgentName } from "./projectAgentDialog.logic";
import { useProjectAgent } from "./useProjectAgent";

export interface ProjectPanelProps {
  open: boolean;
  variant: "docked" | "floating";
  projectId: ProjectId | null;
  projectName: string;
  workspacePath: string;
  defaultModelSelection: ModelSelection | null;
  importedInstructions?: string;
  onOpenCoordinator: (threadId: ThreadId) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onClose: () => void;
}

const ENVIRONMENT_PANEL_OVERLAY_WRAPPER_CLASS_NAME =
  "pointer-events-none absolute inset-y-0 right-0 z-20 flex flex-col p-3";

export function ProjectPanel({
  open,
  variant,
  projectId,
  projectName,
  workspacePath,
  defaultModelSelection,
  importedInstructions,
  onOpenCoordinator,
  onOpenThread,
}: ProjectPanelProps) {
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [taskDraft, setTaskDraft] = useState("");
  const agent = useProjectAgent({ projectId, enabled: open && projectId !== null });
  const coordinatorName =
    agent.overview?.config?.coordinatorName ?? defaultProjectAgentName(projectName);
  const folderLabel = basenameOfPath(workspacePath) || workspacePath || projectName;
  const configured = agent.overview?.configured === true;
  const coordinatorModel =
    agent.overview?.config?.coordinatorModelSelection ?? defaultModelSelection;

  const content = (
    <div className="flex flex-col gap-0.5 p-1.5">
      <div className="flex items-center justify-between gap-2 px-2 pb-0.5 pt-0.5">
        <EnvironmentPanelTitle>Project</EnvironmentPanelTitle>
        {configured ? (
          <div className="flex items-center gap-0.5">
            {agent.overview?.goal?.status === "active" ? (
              <IconButton type="button" label="Pause goal" onClick={() => void agent.pauseGoal()}>
                <PauseIcon className="size-3.5" />
              </IconButton>
            ) : null}
            {agent.overview?.goal?.status === "paused" ? (
              <IconButton type="button" label="Resume goal" onClick={() => void agent.resumeGoal()}>
                <PlayIcon className="size-3.5" />
              </IconButton>
            ) : null}
            <IconButton
              type="button"
              label="Project settings"
              tooltip="Project settings"
              className="-mr-[7px] sm:-mr-[5px]"
              onClick={() => setAgentDialogOpen(true)}
            >
              <SettingsIcon className="size-3.5" />
            </IconButton>
          </div>
        ) : null}
      </div>

      {agent.error ? (
        <p className="px-2 text-[11px] text-destructive" role="alert">
          {agent.error}
        </p>
      ) : null}

      <EnvironmentRow
        icon={<FolderClosed className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
        label={
          <span className="truncate" title={workspacePath}>
            {folderLabel}
          </span>
        }
      />

      {configured && agent.overview?.config ? (
        <EnvironmentRow
          icon={<BotIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label={coordinatorName}
          trailing={
            <span className="text-[10px] text-muted-foreground">
              {agent.overview.coordinatorStatus}
            </span>
          }
          onClick={() => onOpenCoordinator(agent.overview!.config!.coordinatorThreadId)}
        />
      ) : (
        <EnvironmentRow
          icon={<BotIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label="Set up project agent"
          onClick={() => setAgentDialogOpen(true)}
        />
      )}

      {coordinatorModel ? (
        <p className="px-2 text-[11px] text-muted-foreground">
          {coordinatorModel.provider} / {coordinatorModel.model}
        </p>
      ) : null}

      {configured ? (
        <>
          {agent.overview?.goal &&
          (agent.overview.goal.status === "active" || agent.overview.goal.status === "paused") ? (
            <EnvironmentRow
              icon={<WorkflowIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
              label={
                <span className="truncate" title={agent.overview.goal.objective}>
                  {agent.overview.goal.objective}
                </span>
              }
              trailing={
                <span className="text-[10px] text-muted-foreground">
                  {agent.overview.goal.status === "paused" ? "Paused" : "Working"}
                </span>
              }
              onClick={() => onOpenCoordinator(agent.overview!.config!.coordinatorThreadId)}
            />
          ) : null}

          {agent.overview?.digest ? (
            <>
              <EnvironmentSectionDivider />
              <EnvironmentCollapsibleSection label="Summary">
                <ProjectSummary digest={agent.overview.digest} onOpenThread={onOpenThread} />
              </EnvironmentCollapsibleSection>
            </>
          ) : null}

          {agent.overview?.blockers.map((blocker) => (
            <p key={blocker.taskId} className="px-2 text-[11px] text-destructive">
              Blocked: {blocker.title} — {blocker.reason}
            </p>
          ))}

          {PROJECT_CONTEXT_PREVIEW_DOCUMENTS.map((document, index) => (
            <div key={document.logicalPath}>
              <EnvironmentSectionDivider />
              <EnvironmentCollapsibleSection label={document.label} defaultOpen={index === 0}>
                <ProjectContextFile
                  logicalPath={document.logicalPath}
                  editable={document.editable}
                  enabled={open}
                  projectId={projectId}
                  agent={agent}
                />
              </EnvironmentCollapsibleSection>
            </div>
          ))}

          <EnvironmentSectionDivider />
          <EnvironmentCollapsibleSection label="Work" defaultOpen={false}>
            <WorkList
              tasks={agent.tasks}
              busy={agent.busy}
              taskDraft={taskDraft}
              onTaskDraftChange={setTaskDraft}
              onCreate={() => {
                if (taskDraft.trim().length === 0) return;
                void agent.createTask(taskDraft.trim());
                setTaskDraft("");
              }}
              onAccept={(task) => void agent.acceptTask(task)}
              onArchive={(task) => void agent.archiveTask(task)}
              onOpenThread={onOpenThread}
              loadEvidence={agent.loadEvidence}
            />
          </EnvironmentCollapsibleSection>

          <EnvironmentSectionDivider />
          <EnvironmentCollapsibleSection label="Activity" defaultOpen={false}>
            <div className="flex flex-col gap-1 px-1 py-1">
              {agent.threads.length > 0 ? (
                <>
                  <EnvironmentSectionLabel>Thread coverage</EnvironmentSectionLabel>
                  {agent.threads.map((thread) => (
                    <label key={thread.threadId} className="flex items-center gap-2 text-[11px]">
                      <input
                        type="checkbox"
                        checked={!thread.excluded}
                        onChange={(event) =>
                          void agent.excludeThread(thread.threadId, !event.target.checked)
                        }
                      />
                      <button
                        type="button"
                        className="text-left"
                        onClick={() => onOpenThread(thread.threadId)}
                      >
                        {thread.threadId} ({thread.summaryStatus})
                      </button>
                    </label>
                  ))}
                  <EnvironmentSectionDivider />
                </>
              ) : null}
              {agent.activity.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No activity yet.</p>
              ) : (
                agent.activity.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="rounded px-1 py-0.5 text-left text-[11px] hover:bg-[var(--color-background-elevated-secondary)]"
                    onClick={() => {
                      if (item.actorThreadId) onOpenThread(item.actorThreadId);
                    }}
                  >
                    {item.summary}
                  </button>
                ))
              )}
              {agent.activityCursor ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void agent.loadMoreActivity()}
                >
                  Load older activity
                </Button>
              ) : null}
            </div>
          </EnvironmentCollapsibleSection>
        </>
      ) : (
        <p className="px-2 py-1 text-[12px] text-muted-foreground">
          Shared context, tasks, and summaries live in this project folder after you set up the
          agent. Setup does not launch a model.
        </p>
      )}
    </div>
  );

  return (
    <>
      <div
        className={ENVIRONMENT_PANEL_OVERLAY_WRAPPER_CLASS_NAME}
        data-environment-panel-variant={variant}
        aria-hidden={!open}
      >
        <div
          className={cn(
            ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
            AUXILIARY_PANEL_MOTION_CLASS,
            "flex max-h-full w-72 flex-col",
            open
              ? "pointer-events-auto translate-x-0 opacity-100"
              : "pointer-events-none translate-x-full opacity-0",
          )}
        >
          <div className="min-h-0 overflow-y-auto">{content}</div>
        </div>
      </div>
      <ProjectAgentDialog
        open={agentDialogOpen}
        mode={configured ? "edit" : "setup"}
        projectId={projectId}
        projectName={projectName}
        agentName={coordinatorName}
        workspacePath={workspacePath}
        projectCwd={workspacePath}
        defaultModelSelection={defaultModelSelection}
        currentModelSelection={agent.overview?.config?.coordinatorModelSelection ?? null}
        expectedRevision={agent.overview?.config?.revision}
        busy={agent.busy}
        error={agent.error}
        onOpenChange={setAgentDialogOpen}
        onSave={async ({ coordinatorName: nextName, modelSelection, expectedRevision }) => {
          const saved = await agent.configure({
            modelSelection,
            coordinatorName: nextName,
            ...(agent.overview?.config?.workerRouting
              ? { workerRouting: agent.overview.config.workerRouting }
              : {}),
            ...(agent.overview?.config?.limits ? { limits: agent.overview.config.limits } : {}),
            ...(importedInstructions?.trim() ? { importedInstructions } : {}),
            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
          });
          if (saved) setAgentDialogOpen(false);
        }}
      />
    </>
  );
}

function WorkList({
  tasks,
  busy,
  taskDraft,
  onTaskDraftChange,
  onCreate,
  onAccept,
  onArchive,
  onOpenThread,
  loadEvidence,
}: {
  tasks: ReturnType<typeof useProjectAgent>["tasks"];
  busy: boolean;
  taskDraft: string;
  onTaskDraftChange: (value: string) => void;
  onCreate: () => void;
  onAccept: (task: ReturnType<typeof useProjectAgent>["tasks"][number]) => void;
  onArchive: (task: ReturnType<typeof useProjectAgent>["tasks"][number]) => void;
  onOpenThread: (threadId: ThreadId) => void;
  loadEvidence: ReturnType<typeof useProjectAgent>["loadEvidence"];
}) {
  const [evidenceByTask, setEvidenceByTask] = useState<Record<string, string>>({});
  return (
    <div className="flex flex-col gap-1 px-1 py-1">
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate();
        }}
      >
        <input
          value={taskDraft}
          onChange={(event) => onTaskDraftChange(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-[12px]"
          placeholder="New task"
        />
        <Button type="submit" size="sm" disabled={busy || taskDraft.trim().length === 0}>
          Add
        </Button>
      </form>
      {tasks.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">No tasks yet.</p>
      ) : (
        tasks.map((task) => (
          <div key={task.id} className="rounded-md px-1 py-1">
            <p className="text-[12px]">
              {task.title} <span className="text-muted-foreground">({task.status})</span>
            </p>
            {task.dependsOnTaskIds.length > 0 ? (
              <p className="text-[10px] text-muted-foreground">
                Depends on {task.dependsOnTaskIds.length} task
                {task.dependsOnTaskIds.length === 1 ? "" : "s"}
              </p>
            ) : null}
            {task.assignedThreadId ? (
              <button
                type="button"
                className="text-[11px] text-muted-foreground underline"
                onClick={() => onOpenThread(task.assignedThreadId!)}
              >
                Open worker thread
              </button>
            ) : null}
            {task.status === "review" ? (
              <div className="flex flex-col gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void loadEvidence(task.id).then((evidence) => {
                      setEvidenceByTask((current) => ({
                        ...current,
                        [task.id]:
                          evidence.map((item) => item.summary).join(" · ") || "No evidence yet",
                      }));
                    });
                  }}
                >
                  Show evidence
                </Button>
                {evidenceByTask[task.id] ? (
                  <p className="text-[11px] text-muted-foreground">{evidenceByTask[task.id]}</p>
                ) : null}
                <Button type="button" size="sm" onClick={() => onAccept(task)}>
                  Accept evidence
                </Button>
              </div>
            ) : null}
            {task.archivedAt ? (
              <p className="text-[10px] text-muted-foreground">Archived</p>
            ) : (
              <Button type="button" size="sm" variant="ghost" onClick={() => onArchive(task)}>
                Archive
              </Button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

const CONTEXT_TEXTAREA_CLASS_NAME =
  "relative inline-flex w-full rounded-lg border border-[color:var(--color-border-light)] bg-transparent text-[length:var(--app-font-size-ui,12px)] text-foreground transition-colors has-focus-visible:border-foreground/25 [&_[data-slot=textarea]]:px-3 [&_[data-slot=textarea]]:py-2";

function ProjectSummary({
  digest,
  onOpenThread,
}: {
  digest: NonNullable<ReturnType<typeof useProjectAgent>["overview"]>["digest"];
  onOpenThread: (threadId: ThreadId) => void;
}) {
  if (!digest) return null;
  const updating = digest.generationState === "pending" || digest.generationState === "running";
  return (
    <div className="flex flex-col gap-1.5 px-2 pb-1.5">
      {digest.summary ? (
        <ChatMarkdown
          text={digest.summary}
          cwd={undefined}
          isStreaming={updating}
          className={ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME}
        />
      ) : updating ? (
        <div className="flex flex-col gap-1.5" aria-hidden>
          <div className="h-2.5 w-full rounded bg-[var(--color-background-button-secondary-hover)]/45 motion-safe:animate-pulse" />
          <div className="h-2.5 w-4/5 rounded bg-[var(--color-background-button-secondary-hover)]/35 motion-safe:animate-pulse" />
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">No summary yet.</p>
      )}
      {updating ? <p className="text-[10px] text-muted-foreground">Updating…</p> : null}
      {digest.generationState === "failed" ? (
        <p className="text-[11px] text-muted-foreground" role="status">
          {digest.lastError ?? "Could not update the summary. It will retry on its own."}
        </p>
      ) : null}
      {digest.focusItems.slice(0, 5).map((item) => (
        <EnvironmentRow
          key={item.id}
          icon={<WorkflowIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
          label={item.title}
          onClick={() => {
            if (item.sourceThreadId) onOpenThread(item.sourceThreadId);
          }}
        />
      ))}
    </div>
  );
}

function ProjectContextFile({
  logicalPath,
  editable,
  enabled,
  projectId,
  agent,
}: {
  logicalPath: string;
  editable: boolean;
  enabled: boolean;
  projectId: ProjectId | null;
  agent: ReturnType<typeof useProjectAgent>;
}) {
  const [body, setBody] = useState("");
  const [revision, setRevision] = useState(0);
  const [conflict, setConflict] = useState<string | null>(null);
  const generationRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const revisionRef = useRef(0);
  const focusedRef = useRef(false);

  useEffect(() => {
    revisionRef.current = revision;
  }, [revision]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    const generation = ++generationRef.current;
    void (async () => {
      try {
        const read = await agent.readDocument(logicalPath);
        if (generationRef.current !== generation || !read) return;
        if (!focusedRef.current) {
          setBody(read.document.content);
        }
        setRevision(read.document.revision);
        setConflict(
          read.head.conflictPending
            ? "This file changed outside Synara. Keep typing to overwrite, or reopen the panel."
            : null,
        );
      } catch (cause) {
        if (generationRef.current !== generation) return;
        setConflict(cause instanceof Error ? cause.message : "Failed to load this file.");
      }
    })();
  }, [agent, enabled, logicalPath, projectId]);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, []);

  const save = (content: string) => {
    void agent
      .writeDocument({
        logicalPath,
        content,
        expectedRevision: revisionRef.current,
      })
      .then((saved) => {
        setRevision(saved.revision);
        setConflict(null);
      })
      .catch((cause: unknown) => {
        setConflict(cause instanceof Error ? cause.message : "Could not save this file.");
      });
  };

  return (
    <div className="px-2 pb-1">
      {conflict ? (
        <p className="pb-1 text-[11px] text-destructive" role="alert">
          {conflict}
        </p>
      ) : null}
      {editable ? (
        <Textarea
          unstyled
          className={CONTEXT_TEXTAREA_CLASS_NAME}
          value={body}
          aria-label={logicalPath}
          placeholder="Type here"
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => {
            focusedRef.current = false;
            if (debounceRef.current !== null) {
              window.clearTimeout(debounceRef.current);
              debounceRef.current = null;
            }
            save(body);
          }}
          onChange={(event) => {
            const next = event.target.value;
            setBody(next);
            if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
            debounceRef.current = window.setTimeout(() => {
              debounceRef.current = null;
              save(next);
            }, 500);
          }}
        />
      ) : body.trim().length > 0 ? (
        <ChatMarkdown
          text={body}
          cwd={undefined}
          isStreaming={false}
          className={ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME}
        />
      ) : (
        <p className="text-[12px] text-muted-foreground">Nothing here yet.</p>
      )}
    </div>
  );
}
