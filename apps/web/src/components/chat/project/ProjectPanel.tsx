import type { ModelSelection, ProjectId, ThreadId } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";

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
  onClose,
}: ProjectPanelProps) {
  const [view, setView] = useState<ProjectPanelView>("overview");
  const [goalDraft, setGoalDraft] = useState("");
  const agent = useProjectAgent({ projectId, enabled: open && projectId !== null });
  const coordinatorName = useMemo(() => `${projectName} Coordinator`, [projectName]);

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
            <IconButton type="button" label="Project settings">
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
        <div className="flex flex-col gap-2 px-1 py-2">
          <p className="text-[12px] text-muted-foreground">
            Set up a named coordinator for this project. Opening Project does not launch a model.
            Assigned work starts only when you start a goal.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={agent.busy || !defaultModelSelection}
            onClick={() => {
              if (!defaultModelSelection) return;
              void agent.configure(defaultModelSelection, coordinatorName, importedInstructions);
            }}
          >
            Set up coordinator
          </Button>
        </div>
      ) : (
        <>
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
              {agent.overview.goal ? (
                <>
                  <EnvironmentSectionDivider />
                  <EnvironmentSectionLabel>Active goal</EnvironmentSectionLabel>
                  <p className="text-[12px]">{agent.overview.goal.objective}</p>
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
                  <Button type="submit" size="sm" disabled={agent.busy || goalDraft.trim().length === 0}>
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
                  {agent.overview.digest.historicalCoverage === "partial" ? (
                    <p className="text-[11px] text-muted-foreground">
                      Historical coverage is partial. Remaining threads are not yet summarized.
                    </p>
                  ) : null}
                  {agent.overview.digest.focusItems.slice(0, 5).map((item) => (
                    <EnvironmentRow key={item.id} icon={<WorkflowIcon className="size-4" />} label={item.title} />
                  ))}
                </>
              ) : null}
              {agent.overview.blockers.map((blocker) => (
                <p key={blocker.taskId} className="text-[11px] text-destructive">
                  Blocked: {blocker.title}
                </p>
              ))}
            </div>
          ) : null}

          {view === "work" ? (
            <div className="flex flex-col gap-1 px-1 py-1">
              {agent.tasks.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No tasks yet.</p>
              ) : (
                agent.tasks.map((task) => (
                  <div key={task.id} className="rounded-md px-1 py-1">
                    <p className="text-[12px]">
                      {task.title}{" "}
                      <span className="text-muted-foreground">({task.status})</span>
                    </p>
                    {task.status === "review" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void agent.acceptTask(task)}
                      >
                        Accept evidence
                      </Button>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          ) : null}

          {view === "context" ? (
            <ContextDocuments projectId={projectId} enabled={open} />
          ) : null}

          {view === "activity" ? (
            <ActivityList projectId={projectId} enabled={open} />
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

function ContextDocuments({
  projectId,
  enabled,
}: {
  projectId: ProjectId | null;
  enabled: boolean;
}) {
  const [paths, setPaths] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("instructions.md");
  const [body, setBody] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled || !projectId) return;
    void (async () => {
      const { readNativeApi } = await import("~/nativeApi");
      const native = readNativeApi();
      if (!native?.projectAgent) return;
      const listed = await native.projectAgent.listDocuments({ projectId });
      setPaths(listed.documents.map((doc) => doc.logicalPath));
      const read = await native.projectAgent.readDocument({ projectId, logicalPath: selected });
      setBody(read.document.content);
      setRevision(read.document.revision);
    })().catch(() => undefined);
  }, [enabled, projectId, selected]);

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
      <textarea
        className="min-h-32 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[11px]"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-label="Document source"
      />
      <p className="text-[10px] text-muted-foreground">Revision {revision}</p>
    </div>
  );
}

function ActivityList({
  projectId,
  enabled,
}: {
  projectId: ProjectId | null;
  enabled: boolean;
}) {
  const [items, setItems] = useState<ReadonlyArray<{ id: string; summary: string }>>([]);
  useEffect(() => {
    if (!enabled || !projectId) return;
    void (async () => {
      const { readNativeApi } = await import("~/nativeApi");
      const native = readNativeApi();
      if (!native?.projectAgent) return;
      const listed = await native.projectAgent.listActivity({ projectId });
      setItems(listed.activity.map((entry) => ({ id: entry.id, summary: entry.summary })));
    })().catch(() => undefined);
  }, [enabled, projectId]);
  return (
    <div className="flex flex-col gap-1 px-1 py-1">
      {items.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">No activity yet.</p>
      ) : (
        items.map((item) => (
          <p key={item.id} className="text-[11px]">
            {item.summary}
          </p>
        ))
      )}
    </div>
  );
}
