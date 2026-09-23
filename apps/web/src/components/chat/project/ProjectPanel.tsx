import type { ModelSelection, ProjectId, ThreadId } from "@synara/contracts";
import { PROJECT_CONTEXT_PREVIEW_DOCUMENTS } from "@synara/shared/projectAgent";
import { useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { FolderClosed } from "~/components/FolderClosed";
import { IconButton } from "~/components/ui/icon-button";
import { Textarea } from "~/components/ui/textarea";
import {
  ENVIRONMENT_PANEL_MOTION_CLASS,
  ENVIRONMENT_PANEL_OVERLAY_WRAPPER_CLASS_NAME,
  ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME } from "~/components/chat/environment/environmentPanelStyles";
import { basenameOfPath } from "~/file-icons";
import { BotIcon, PauseIcon, PlayIcon, SettingsIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { createSidebarThreadSummariesSelector } from "~/storeSelectors";

import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentCollapsibleSection,
  EnvironmentPanelTitle,
  EnvironmentRow,
  EnvironmentSectionDivider,
} from "../environment/EnvironmentRow";
import { GroupSettingsDialog } from "../group/GroupSettingsDialog";
import { resolveCoordinatorAppearance } from "../group/coordinatorAppearance";
import type { GroupSettingsSection } from "../group/groupSettingsDialog.logic";
import { GroupOverview } from "./GroupOverview";
import { defaultProjectAgentName } from "./projectAgentDialog.logic";
import { projectAgentOverviewConfigured } from "./projectAgentOverview.logic";
import { collectGroupThreadSummaries } from "./groupOverview.logic";
import {
  mergeProjectFocusRows,
  partitionProjectFocusRows,
  projectDigestFocusRows,
  projectThreadIndexFocusRows,
  sanitizeProjectDigestSummary,
  type ProjectFocusRow,
} from "./projectPanel.logic";
import { useProjectAgent } from "./useProjectAgent";
import { useProjectAgentSummaries } from "./useProjectAgentSummaries";

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
  onOpenThreadSplit: (threadId: ThreadId) => void;
  onOpenAutomation: (automationId: string) => void;
  onClose: () => void;
  settingsDialogOpen?: boolean;
  settingsInitialSection?: GroupSettingsSection | undefined;
  onSettingsDialogOpenChange?: (open: boolean) => void;
}

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
  onOpenThreadSplit,
  onOpenAutomation,
  onClose,
  settingsDialogOpen,
  settingsInitialSection,
  onSettingsDialogOpenChange,
}: ProjectPanelProps) {
  const [internalDialogOpen, setInternalDialogOpen] = useState(false);
  const agentDialogOpen = settingsDialogOpen ?? internalDialogOpen;
  const setAgentDialogOpen = (open: boolean) => {
    setInternalDialogOpen(open);
    onSettingsDialogOpenChange?.(open);
  };
  const agent = useProjectAgent({
    projectId,
    enabled: open && projectId !== null,
  });
  const { summariesByProjectId } = useProjectAgentSummaries();
  const selectSidebarThreads = useMemo(() => createSidebarThreadSummariesSelector(), []);
  const sidebarThreads = useStore(selectSidebarThreads);
  const allProjects = useStore((state) => state.projects);
  const projectNameById = useMemo(
    () => new Map(allProjects.map((project) => [project.id, project.name] as const)),
    [allProjects],
  );
  const projectCwdById = useMemo(
    () => new Map(allProjects.map((project) => [project.id, project.cwd] as const)),
    [allProjects],
  );
  const coordinatorThreadId = agent.overview?.config?.coordinatorThreadId ?? null;
  const focusRows = useMemo(() => {
    const titlesById = new Map(sidebarThreads.map((thread) => [thread.id, thread.title] as const));
    return mergeProjectFocusRows(
      partitionProjectFocusRows(agent.tasks),
      projectThreadIndexFocusRows({
        threads: agent.threads,
        coordinatorThreadId,
        titlesById,
      }),
    );
  }, [coordinatorThreadId, agent.tasks, agent.threads, sidebarThreads]);
  const digestFocus = useMemo(
    () => projectDigestFocusRows(agent.overview?.digest?.focusItems ?? []),
    [agent.overview?.digest?.focusItems],
  );
  const memberThreadIds = useMemo(() => {
    const ids = new Set<ThreadId>();
    for (const task of agent.tasks) {
      if (task.assignedThreadId) ids.add(task.assignedThreadId);
    }
    for (const entry of agent.threads) {
      if (!entry.excluded && !entry.archived) ids.add(entry.threadId);
    }
    if (coordinatorThreadId) ids.add(coordinatorThreadId);
    return ids;
  }, [agent.tasks, agent.threads, coordinatorThreadId]);
  const groupThreads = useMemo(
    () =>
      projectId === null
        ? []
        : collectGroupThreadSummaries({
            threads: sidebarThreads,
            groupProjectId: projectId,
            memberThreadIds,
            coordinatorThreadId,
          }),
    [sidebarThreads, projectId, memberThreadIds, coordinatorThreadId],
  );
  const contextDocuments = PROJECT_CONTEXT_PREVIEW_DOCUMENTS.filter(
    (document) => document.logicalPath !== "notes.md",
  );
  const coordinatorName =
    agent.overview?.config?.coordinatorName ?? defaultProjectAgentName(projectName);
  const folderLabel = basenameOfPath(workspacePath) || workspacePath || projectName;
  // Configured must not depend on the panel being open — the overview is only
  // loaded while open, so either feed decides it: the panel's own overview, or
  // the shared summaries store (fed by mutations, the config stream while the
  // panel is open, and debounced re-lists on automation events). A stale
  // unconfigured overview must not shadow a fresher configured summary.
  const configured =
    projectAgentOverviewConfigured(agent.overview) ||
    (projectId !== null && summariesByProjectId.get(projectId)?.configured === true);
  const coordinatorModel =
    agent.overview?.config?.coordinatorModelSelection ?? defaultModelSelection;
  const coordinatorAppearance = resolveCoordinatorAppearance({
    coordinatorIcon: agent.overview?.config?.coordinatorIcon,
    coordinatorColor: agent.overview?.config?.coordinatorColor,
  });
  const CoordinatorGlyph = coordinatorAppearance.Icon;
  const coordinatorIconClassName = cn(
    ENVIRONMENT_ROW_ICON_CLASS_NAME,
    coordinatorAppearance.iconClassName,
  );

  const content = (
    <div className="flex flex-col gap-0.5 p-1.5">
      <div className="flex items-center justify-between gap-2 px-2 pb-0.5 pt-0.5">
        <EnvironmentPanelTitle>Group</EnvironmentPanelTitle>
        <div className="flex items-center gap-0.5">
          {configured ? (
            <>
              {agent.overview?.goal?.status === "active" ? (
                <IconButton type="button" label="Pause goal" onClick={() => void agent.pauseGoal()}>
                  <PauseIcon className="size-3.5" />
                </IconButton>
              ) : null}
              {agent.overview?.goal?.status === "paused" ? (
                <IconButton
                  type="button"
                  label="Resume goal"
                  onClick={() => void agent.resumeGoal()}
                >
                  <PlayIcon className="size-3.5" />
                </IconButton>
              ) : null}
              <IconButton
                type="button"
                label="Group settings"
                tooltip="Group settings"
                onClick={() => setAgentDialogOpen(true)}
              >
                <SettingsIcon className="size-3.5" />
              </IconButton>
            </>
          ) : null}
          <IconButton type="button" label="Close group panel" tooltip="Close" onClick={onClose}>
            <XIcon className="size-3.5" />
          </IconButton>
        </div>
      </div>

      {agent.error ? (
        <p className="px-2 text-ui-sm text-destructive" role="alert">
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
          icon={<CoordinatorGlyph className={coordinatorIconClassName} aria-hidden />}
          label={coordinatorName}
          trailing={
            <span className="text-ui-xs text-muted-foreground">
              {agent.overview.coordinatorStatus}
            </span>
          }
          onClick={() => onOpenCoordinator(agent.overview!.config!.coordinatorThreadId)}
        />
      ) : (
        <EnvironmentRow
          icon={<BotIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label="Set up coordinator"
          onClick={() => setAgentDialogOpen(true)}
        />
      )}

      {coordinatorModel ? (
        <p className="px-2 text-ui-sm text-muted-foreground">
          {coordinatorModel.provider} / {coordinatorModel.model}
        </p>
      ) : null}

      {configured && projectId !== null ? (
        <>
          <EnvironmentSectionDivider />
          <ProjectFocusCard
            summary={sanitizeProjectDigestSummary(agent.overview?.digest?.summary ?? null)}
            updating={
              agent.overview?.digest?.generationState === "pending" ||
              agent.overview?.digest?.generationState === "running"
            }
            items={digestFocus.length > 0 ? digestFocus : focusRows.open}
            onOpenThread={onOpenThread}
          />

          {agent.overview?.blockers.map((blocker) => (
            <p key={blocker.taskId} className="px-2 text-ui-sm text-destructive">
              Blocked: {blocker.title} — {blocker.reason}
            </p>
          ))}

          {open ? (
            <GroupOverview
              groupProjectId={projectId}
              groupName={projectName}
              memberThreadIds={memberThreadIds}
              groupThreads={groupThreads}
              projectNameById={projectNameById}
              projectCwdById={projectCwdById}
              agent={agent}
              onOpenThread={onOpenThread}
              onOpenThreadSplit={onOpenThreadSplit}
              onOpenAutomation={onOpenAutomation}
            />
          ) : null}

          <EnvironmentSectionDivider />
          <EnvironmentCollapsibleSection label="Context" defaultOpen={false}>
            <div className="flex flex-col gap-0.5 pb-1">
              {contextDocuments.map((document) => (
                <ProjectContextFile
                  key={document.logicalPath}
                  logicalPath={document.logicalPath}
                  editable={document.editable}
                  enabled={open}
                  projectId={projectId}
                  agent={agent}
                />
              ))}
            </div>
          </EnvironmentCollapsibleSection>
        </>
      ) : (
        <p className="px-2 py-1 text-ui text-muted-foreground">
          Threads, context, and memory for the group live in this folder after you set up the
          coordinator. Setup does not launch a model.
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
        inert={!open}
      >
        <div
          className={cn(
            ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
            ENVIRONMENT_PANEL_MOTION_CLASS,
            "flex max-h-full w-72 flex-col",
            open
              ? "pointer-events-auto translate-x-0 opacity-100"
              : "pointer-events-none translate-x-full opacity-0",
          )}
        >
          <div className="min-h-0 overflow-y-auto">{content}</div>
        </div>
      </div>
      {projectId !== null ? (
        <GroupSettingsDialog
          key={projectId}
          open={agentDialogOpen}
          mode={configured ? "edit" : "onboarding"}
          projectId={projectId}
          projectName={projectName}
          workspacePath={workspacePath}
          defaultModelSelection={defaultModelSelection}
          initialSection={settingsInitialSection}
          importedInstructions={importedInstructions}
          onOpenChange={setAgentDialogOpen}
          onSaved={(overview) => {
            if (configured) return;
            const coordinatorThreadId = overview.config?.coordinatorThreadId;
            if (coordinatorThreadId) onOpenCoordinator(coordinatorThreadId);
          }}
        />
      ) : null}
    </>
  );
}

const CONTEXT_TEXTAREA_CLASS_NAME =
  "relative inline-flex w-full rounded-lg border border-[color:var(--color-border-light)] bg-transparent text-ui text-foreground transition-colors has-focus-visible:border-foreground/25 [&_[data-slot=textarea]]:px-3 [&_[data-slot=textarea]]:py-2";

function ProjectFocusCard({
  summary,
  updating,
  items,
  onOpenThread,
}: {
  summary: string | null;
  updating: boolean;
  items: ReadonlyArray<ProjectFocusRow>;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <div className="mx-1 mb-1 rounded-xl bg-[var(--color-background-elevated-secondary)] px-2.5 py-2">
      <p className="px-0.5 pb-1.5 text-ui-sm font-medium text-muted-foreground">Focus</p>
      {summary ? (
        <p className="px-0.5 pb-1.5 text-ui text-muted-foreground">{summary}</p>
      ) : updating ? (
        <p className="px-0.5 pb-1.5 text-ui-xs text-muted-foreground">Updating…</p>
      ) : null}
      {items.length === 0 && !summary ? (
        <p className="px-0.5 text-ui text-muted-foreground">Nothing in focus yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex gap-1.5 text-ui leading-snug">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-foreground/45" aria-hidden />
              <ProjectFocusLink row={item} onOpenThread={onOpenThread} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectFocusLink({
  row,
  onOpenThread,
}: {
  row: ProjectFocusRow;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const title = row.threadId ? (
    <button
      type="button"
      className="text-left font-medium text-foreground underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground/60"
      onClick={() => onOpenThread(row.threadId!)}
    >
      {row.title}
    </button>
  ) : (
    <span className="font-medium text-foreground">{row.title}</span>
  );
  return (
    <p className="min-w-0 text-ui leading-snug text-muted-foreground">
      {title}
      {row.detail ? <> — {row.detail}</> : null}
    </p>
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
  // Saves run one at a time per document: two overlapping writes with the same
  // expectedRevision would produce a false conflict. `lastRequested` is what the
  // latest input holds — a newer change supersedes an in-flight save.
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastRequestedRef = useRef<string | null>(null);
  const lastSavedRef = useRef<string | null>(null);
  const readDocument = agent.readDocument;

  useEffect(() => {
    revisionRef.current = revision;
  }, [revision]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    const generation = ++generationRef.current;
    void (async () => {
      try {
        const read = await readDocument(logicalPath);
        if (generationRef.current !== generation || !read) return;
        if (!focusedRef.current) {
          setBody(read.document.content);
        }
        setRevision(read.document.revision);
        lastRequestedRef.current = read.document.content;
        lastSavedRef.current = read.document.content;
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
  }, [readDocument, enabled, logicalPath, projectId]);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, []);

  const save = (content: string) => {
    lastRequestedRef.current = content;
    if (lastSavedRef.current === content) return;
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      // A newer keystroke superseded this save while an earlier write was in flight.
      const pending = lastRequestedRef.current;
      if (pending === null || pending === lastSavedRef.current) return;
      try {
        const saved = await agent.writeDocument({
          logicalPath,
          content: pending,
          expectedRevision: revisionRef.current,
        });
        setRevision(saved.revision);
        lastSavedRef.current = pending;
        setConflict(null);
      } catch (cause) {
        setConflict(cause instanceof Error ? cause.message : "Could not save this file.");
      }
    });
  };

  return (
    <div className="px-2 pb-1">
      {conflict ? (
        <p className="pb-1 text-ui-sm text-destructive" role="alert">
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
          className={cn(ENVIRONMENT_PANEL_RECAP_MARKDOWN_CLASS_NAME, "pull-request-prose")}
        />
      ) : (
        <p className="text-ui text-muted-foreground">Nothing here yet.</p>
      )}
    </div>
  );
}
