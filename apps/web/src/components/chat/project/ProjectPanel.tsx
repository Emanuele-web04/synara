import type { ModelSelection, ProjectId, ThreadId } from "@synara/contracts";
import { DEFAULT_PROJECT_AGENT_LIMITS } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { IconButton } from "~/components/ui/icon-button";
import { PauseIcon, PlayIcon, SettingsIcon, WorkflowIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { ChatAuxiliaryPanel } from "../auxiliary/ChatAuxiliaryPanel";
import {
  EnvironmentPanelTitle,
  EnvironmentRow,
  EnvironmentSectionDivider,
  EnvironmentSectionLabel,
} from "../environment/EnvironmentRow";
import { useProjectAgent } from "./useProjectAgent";

export type ProjectPanelView = "overview" | "work" | "context" | "activity";

export interface ProjectPanelProps {
  open: boolean;
  variant: "docked" | "floating";
  mobile: boolean;
  projectId: ProjectId | null;
  projectName: string;
  defaultModelSelection: ModelSelection | null;
  importedInstructions?: string;
  onOpenCoordinator: (threadId: ThreadId) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onClose: () => void;
}

const VIEWS: ReadonlyArray<{ id: ProjectPanelView; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "work", label: "Work" },
  { id: "context", label: "Context" },
  { id: "activity", label: "Activity" },
];

export function ProjectPanel({
  open,
  variant,
  mobile,
  projectId,
  projectName,
  defaultModelSelection,
  importedInstructions,
  onOpenCoordinator,
  onOpenThread,
  onClose,
}: ProjectPanelProps) {
  const [view, setView] = useState<ProjectPanelView>("overview");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const agent = useProjectAgent({ projectId, enabled: open && projectId !== null });
  const coordinatorName = agent.overview?.config?.coordinatorName ?? `${projectName} Coordinator`;

  const content = (
    <div className="flex flex-col gap-1 p-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <EnvironmentPanelTitle>Project</EnvironmentPanelTitle>
        {agent.overview?.config ? (
          <div className="flex items-center gap-0.5">
            <IconButton
              type="button"
              label="Open coordinator"
              onClick={() => onOpenCoordinator(agent.overview!.config!.coordinatorThreadId)}
            >
              <WorkflowIcon className="size-3.5" />
            </IconButton>
            {agent.overview.goal?.status === "active" ? (
              <IconButton type="button" label="Pause goal" onClick={() => void agent.pauseGoal()}>
                <PauseIcon className="size-3.5" />
              </IconButton>
            ) : null}
            {agent.overview.goal?.status === "paused" ? (
              <IconButton type="button" label="Resume goal" onClick={() => void agent.resumeGoal()}>
                <PlayIcon className="size-3.5" />
              </IconButton>
            ) : null}
            <IconButton
              type="button"
              label="Project settings"
              onClick={() => setSettingsOpen((openSettings) => !openSettings)}
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

      {!agent.overview?.configured ? (
        <SetupForm
          coordinatorName={coordinatorName}
          defaultModelSelection={defaultModelSelection}
          busy={agent.busy}
          onSetup={(name) => {
            if (!defaultModelSelection) return;
            void agent.configure({
              modelSelection: defaultModelSelection,
              coordinatorName: name,
              importedInstructions,
            });
          }}
        />
      ) : (
        <>
          {settingsOpen ? (
            <SettingsForm
              name={coordinatorName}
              busy={agent.busy}
              defaultModelSelection={defaultModelSelection}
              currentModel={agent.overview.config?.coordinatorModelSelection ?? null}
              onSave={(name) => {
                if (!defaultModelSelection && !agent.overview?.config?.coordinatorModelSelection) {
                  return;
                }
                void agent.configure({
                  modelSelection:
                    defaultModelSelection ?? agent.overview!.config!.coordinatorModelSelection,
                  coordinatorName: name,
                  workerRouting: agent.overview?.config?.workerRouting,
                  limits: agent.overview?.config?.limits,
                  expectedRevision: agent.overview?.config?.revision,
                });
                setSettingsOpen(false);
              }}
            />
          ) : null}
          <div className="grid grid-cols-4 gap-0.5 px-1">
            {VIEWS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={cn(
                  "rounded-md px-1 py-1 text-[10px] font-medium",
                  view === entry.id
                    ? "bg-[var(--color-background-elevated-secondary)] text-foreground"
                    : "text-muted-foreground hover:bg-[var(--color-background-elevated-secondary)]",
                )}
                aria-pressed={view === entry.id}
                onClick={() => setView(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {view === "overview" ? (
            <div className="flex flex-col gap-1 px-1 py-1">
              <EnvironmentSectionLabel>Coordinator</EnvironmentSectionLabel>
              <p className="text-[12px]">{agent.overview.config?.coordinatorName}</p>
              <p className="text-[11px] text-muted-foreground">
                Status: {agent.overview.coordinatorStatus}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Model is used only after a goal starts. Setup does not launch a turn.
              </p>
              {agent.overview.goal ? (
                <>
                  <EnvironmentSectionDivider />
                  <EnvironmentSectionLabel>Active goal</EnvironmentSectionLabel>
                  <p className="text-[12px]">{agent.overview.goal.objective}</p>
                  <p className="text-[11px] text-muted-foreground">{agent.overview.goal.status}</p>
                  {agent.overview.goal.status === "active" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void agent.stopGoal()}
                    >
                      Stop goal
                    </Button>
                  ) : null}
                </>
              ) : (
                <form
                  className="flex flex-col gap-1 pt-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (goalDraft.trim().length === 0) return;
                    void agent.startGoal(goalDraft.trim());
                    setGoalDraft("");
                  }}
                >
                  <label className="text-[11px] text-muted-foreground" htmlFor="project-goal">
                    Start goal
                  </label>
                  <textarea
                    id="project-goal"
                    value={goalDraft}
                    onChange={(event) => setGoalDraft(event.target.value)}
                    className="min-h-16 rounded-md border border-border bg-transparent px-2 py-1 text-[12px]"
                    placeholder="What should the coordinator accomplish?"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={agent.busy || goalDraft.trim().length === 0}
                  >
                    <PlayIcon className="size-3.5" />
                    Start goal
                  </Button>
                </form>
              )}
              {agent.overview.digest ? (
                <>
                  <EnvironmentSectionDivider />
                  <EnvironmentSectionLabel>Summary</EnvironmentSectionLabel>
                  <p className="text-[12px]">{agent.overview.digest.summary}</p>
                  {agent.overview.digest.generationState === "failed" ? (
                    <p className="text-[11px] text-destructive" role="alert">
                      {agent.overview.digest.lastError ??
                        "Summary refresh failed. Last good summary is shown."}
                    </p>
                  ) : null}
                  {agent.overview.digest.historicalCoverage === "partial" ? (
                    <div className="flex flex-col gap-1">
                      <p className="text-[11px] text-muted-foreground">
                        Historical coverage is partial. {agent.overview.digest.pendingThreadCount}{" "}
                        threads remain unsummarized.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void agent.backfillSummaries()}
                      >
                        Backfill remaining threads
                      </Button>
                    </div>
                  ) : null}
                  {agent.overview.digest.focusItems.slice(0, 8).map((item) => (
                    <EnvironmentRow
                      key={item.id}
                      icon={<WorkflowIcon className="size-4" />}
                      label={item.title}
                      onClick={() => {
                        if (item.sourceThreadId) onOpenThread(item.sourceThreadId);
                      }}
                    />
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void agent.refreshDigest()}
                  >
                    Refresh summary
                  </Button>
                </>
              ) : null}
              {agent.overview.blockers.map((blocker) => (
                <p key={blocker.taskId} className="text-[11px] text-destructive">
                  Blocked: {blocker.title} — {blocker.reason}
                </p>
              ))}
            </div>
          ) : null}

          {view === "work" ? (
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
          ) : null}

          {view === "context" ? (
            <ContextDocuments projectId={projectId} enabled={open} agent={agent} />
          ) : null}

          {view === "activity" ? (
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
          ) : null}
        </>
      )}
    </div>
  );

  return (
    <ChatAuxiliaryPanel
      open={open}
      variant={variant}
      mobile={mobile}
      title="Project"
      description="Persistent coordinator, tasks, and shared context for this project."
      onClose={onClose}
    >
      {content}
    </ChatAuxiliaryPanel>
  );
}

function SetupForm({
  coordinatorName,
  defaultModelSelection,
  busy,
  onSetup,
}: {
  coordinatorName: string;
  defaultModelSelection: ModelSelection | null;
  busy: boolean;
  onSetup: (name: string) => void;
}) {
  const [name, setName] = useState(coordinatorName);
  return (
    <form
      className="flex flex-col gap-2 px-1 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSetup(name.trim() || coordinatorName);
      }}
    >
      <p className="text-[12px] text-muted-foreground">
        Set up a named coordinator for this project. Opening Project does not launch a model.
        Assigned work starts only when you start a goal.
      </p>
      <label className="text-[11px] text-muted-foreground" htmlFor="coordinator-name">
        Coordinator name
      </label>
      <input
        id="coordinator-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="rounded-md border border-border bg-transparent px-2 py-1 text-[12px]"
      />
      <p className="text-[11px] text-muted-foreground">
        Provider/model: {defaultModelSelection?.provider ?? "none"} /{" "}
        {defaultModelSelection?.model ?? "none"}
      </p>
      <p className="text-[11px] text-muted-foreground">
        Default limits: {DEFAULT_PROJECT_AGENT_LIMITS.maxConcurrentWorkers} concurrent workers,{" "}
        {DEFAULT_PROJECT_AGENT_LIMITS.maxNewWorkersPerTurn} new per turn.
      </p>
      <Button type="submit" size="sm" disabled={busy || !defaultModelSelection}>
        Set up coordinator
      </Button>
    </form>
  );
}

function SettingsForm({
  name,
  busy,
  defaultModelSelection,
  currentModel,
  onSave,
}: {
  name: string;
  busy: boolean;
  defaultModelSelection: ModelSelection | null;
  currentModel: ModelSelection | null;
  onSave: (name: string) => void;
}) {
  const [value, setValue] = useState(name);
  return (
    <form
      className="flex flex-col gap-1 px-1 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(value.trim() || name);
      }}
    >
      <EnvironmentSectionLabel>Settings</EnvironmentSectionLabel>
      <label className="text-[11px] text-muted-foreground" htmlFor="settings-name">
        Coordinator name
      </label>
      <input
        id="settings-name"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="rounded-md border border-border bg-transparent px-2 py-1 text-[12px]"
      />
      <p className="text-[11px] text-muted-foreground">
        Current model: {currentModel?.provider}/{currentModel?.model}. Saving uses this chat&apos;s
        model ({defaultModelSelection?.provider}/{defaultModelSelection?.model}) without starting a
        turn.
      </p>
      <Button type="submit" size="sm" disabled={busy}>
        Save settings
      </Button>
    </form>
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

function ContextDocuments({
  projectId,
  enabled,
  agent,
}: {
  projectId: ProjectId | null;
  enabled: boolean;
  agent: ReturnType<typeof useProjectAgent>;
}) {
  const [selected, setSelected] = useState("instructions.md");
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [body, setBody] = useState("");
  const [revision, setRevision] = useState(0);
  const [history, setHistory] = useState<ReadonlyArray<{ revision: number; createdAt: string }>>(
    [],
  );
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!enabled || !projectId) return;
    const generation = ++generationRef.current;
    void (async () => {
      try {
        const read = await agent.readDocument(selected);
        if (generationRef.current !== generation || !read) return;
        setBody(read.document.content);
        setRevision(read.document.revision);
        setHistory(read.history);
        setConflict(
          read.head.conflictPending
            ? "The Markdown file changed outside Synara. Import it or keep the server copy."
            : null,
        );
      } catch (cause) {
        if (generationRef.current !== generation) return;
        setConflict(cause instanceof Error ? cause.message : "Failed to load document.");
      }
    })();
  }, [agent, enabled, projectId, selected]);

  const paths = useMemo(
    () => (agent.documents.length > 0 ? agent.documents.map((doc) => doc.logicalPath) : [selected]),
    [agent.documents, selected],
  );

  return (
    <div className="flex flex-col gap-1 px-1 py-1">
      {paths.map((path) => (
        <button
          key={path}
          type="button"
          className="rounded px-1 py-0.5 text-left text-[11px] hover:bg-[var(--color-background-elevated-secondary)]"
          onClick={() => setSelected(path)}
        >
          {path}
        </button>
      ))}
      <div className="flex gap-1">
        <Button
          type="button"
          size="sm"
          variant={mode === "preview" ? "default" : "ghost"}
          onClick={() => setMode("preview")}
        >
          Preview
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "source" ? "default" : "ghost"}
          onClick={() => setMode("source")}
        >
          Source
        </Button>
      </div>
      {conflict ? (
        <p className="text-[11px] text-destructive" role="alert">
          {conflict}
        </p>
      ) : null}
      {mode === "preview" ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[11px]">{body}</pre>
      ) : (
        <textarea
          className="min-h-32 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[11px]"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          aria-label="Document source"
        />
      )}
      <p className="text-[10px] text-muted-foreground">Revision {revision}</p>
      {history.length > 1 ? (
        <label className="text-[11px] text-muted-foreground">
          History
          <select
            className="ml-1 rounded border border-border bg-transparent"
            value={revision}
            onChange={(event) => {
              const next = Number(event.target.value);
              void agent.readDocument(selected, next).then((read) => {
                if (!read) return;
                setBody(read.document.content);
                setRevision(read.document.revision);
              });
            }}
          >
            {history.map((entry) => (
              <option key={entry.revision} value={entry.revision}>
                r{entry.revision} {entry.createdAt}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          size="sm"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setConflict(null);
            void agent
              .writeDocument({
                logicalPath: selected,
                content: body,
                expectedRevision: revision,
              })
              .then((saved) => {
                setRevision(saved.revision);
                setBody(saved.content);
              })
              .catch((cause: unknown) => {
                setConflict(cause instanceof Error ? cause.message : "Save failed.");
              })
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        {conflict ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              void agent
                .writeDocument({
                  logicalPath: selected,
                  content: body,
                  expectedRevision: revision,
                  importExternal: true,
                })
                .then((saved) => {
                  setRevision(saved.revision);
                  setBody(saved.content);
                  setConflict(null);
                })
                .catch((cause: unknown) => {
                  setConflict(cause instanceof Error ? cause.message : "Import failed.");
                });
            }}
          >
            Import external copy
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            const destination = window.prompt("Export directory");
            if (!destination) return;
            void agent.exportDocuments([selected], destination).catch((cause: unknown) => {
              setConflict(cause instanceof Error ? cause.message : "Export failed.");
            });
          }}
        >
          Export
        </Button>
      </div>
    </div>
  );
}
