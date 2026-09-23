// FILE: GroupSettingsDialog.tsx
// Purpose: Two-pane group settings dialog (General / Memory / Environment / Plugins)
//          used both for group onboarding and for editing a configured group.
// Layer: Group settings dialog
// Exports: GroupSettingsDialog

import type { ModelSelection, ProjectAgentOverview, ProjectId } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { CentralIcon } from "~/lib/central-icons";
import { SidebarLeadingIcon } from "~/components/SidebarLeadingIcon";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";
import { useProjectInstructionsAutosave } from "~/components/chat/environment/EnvironmentProjectInstructionsSection";
import { useProjectInstructionsSource } from "~/components/chat/project/useProjectInstructionsSource";
import { useProjectAgent } from "~/components/chat/project/useProjectAgent";
import { useProjectAgentSummariesStore } from "~/components/chat/project/useProjectAgentSummaries";
import { toDisplayName } from "~/components/profile/profileFormatting";
import { useProfileName } from "~/components/profile/useProfileName";
import { cn, newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  SETTINGS_SIDEBAR_ICON_CLASS_NAME,
  SETTINGS_SIDEBAR_ITEM_CLASS_NAME,
  SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME,
  SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME,
  SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME,
  SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME,
} from "~/settingsSidebarNavStyles";
import { useStore } from "~/store";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

import { GroupEnvironmentSection } from "./GroupEnvironmentSection";
import { GroupGeneralSection } from "./GroupGeneralSection";
import { GroupMemorySection } from "./GroupMemorySection";
import { GroupPluginsSection } from "./GroupPluginsSection";
import {
  GROUP_SETTINGS_SECTION_LABELS,
  GROUP_SETTINGS_SECTIONS,
  buildGroupSettingsBaseline,
  groupSettingsDirtySections,
  resolveSaveAttemptRequestId,
  saveAttemptFingerprint,
  saveGroupSettings,
  type GroupSettingsBaseline,
  type GroupSettingsDraft,
  type GroupSettingsSection,
} from "./groupSettingsDialog.logic";

const GROUP_SETTINGS_SECTION_ICONS: Record<GroupSettingsSection, string> = {
  general: "settings-gear-4",
  memory: "brain",
  environment: "folder-open-front",
  plugins: "plugin-1",
};

export function GroupSettingsDialog(props: {
  readonly open: boolean;
  readonly mode: "onboarding" | "edit";
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly workspacePath: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly initialSection?: GroupSettingsSection | undefined;
  readonly importedInstructions?: string | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved?: ((overview: ProjectAgentOverview) => void) | undefined;
}) {
  const agent = useProjectAgent({ projectId: props.projectId, enabled: props.open });
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const renameProjectLocally = useStore((store) => store.renameProjectLocally);
  const { name: userDisplayName } = useProfileName(
    toDisplayName(
      (homeDir ?? "")
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ?? "there",
    ),
  );
  const instructionsSource = useProjectInstructionsSource(props.open ? props.projectId : null);
  const instructionsAutosave = useProjectInstructionsAutosave({
    projectId: props.open ? props.projectId : null,
    instructions: instructionsSource.instructions,
    onChange: instructionsSource.onChange,
  });

  const [section, setSection] = useState<GroupSettingsSection>("general");
  const [draft, setDraft] = useState<GroupSettingsDraft | null>(null);
  const [baseline, setBaseline] = useState<GroupSettingsBaseline | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The most recent failed save attempt; a retry reuses its requestId only while
  // the payload fingerprint matches so server receipts dedupe the replay.
  const failedAttemptRef = useRef<{ requestId: string; fingerprint: string } | null>(null);
  const openRef = useRef(false);
  const seededNameRef = useRef(props.projectName);

  const config = agent.overview?.config ?? null;

  useEffect(() => {
    if (props.open && !openRef.current) {
      openRef.current = true;
      seededNameRef.current = props.projectName;
      failedAttemptRef.current = null;
      setSection(props.initialSection ?? "general");
      setDraft(null);
      setBaseline(null);
      setSaving(false);
      setSaveError(null);
      return;
    }
    if (!props.open) {
      openRef.current = false;
    }
  }, [props.open, props.initialSection, props.projectName]);

  useEffect(() => {
    if (!props.open || draft !== null || agent.overview === null) return;
    const base = buildGroupSettingsBaseline({
      config,
      projectName: props.projectName,
      defaultModelSelection: props.defaultModelSelection,
    });
    setBaseline(base);
    setDraft(base.draft);
  }, [agent.overview, config, draft, props.defaultModelSelection, props.open, props.projectName]);

  // The project can be renamed while the dialog is open; re-seed the name into
  // baseline, and into the draft too when the user has not edited it.
  useEffect(() => {
    if (!props.open || seededNameRef.current === props.projectName) return;
    const previousName = seededNameRef.current;
    seededNameRef.current = props.projectName;
    setBaseline((current) =>
      current && current.draft.name === previousName
        ? { ...current, draft: { ...current.draft, name: props.projectName } }
        : current,
    );
    setDraft((current) =>
      current && current.name === previousName ? { ...current, name: props.projectName } : current,
    );
  }, [props.open, props.projectName]);

  const dirtySections =
    draft && baseline ? groupSettingsDirtySections(draft, baseline.draft) : new Set();
  const dirty = draft !== null && baseline !== null && dirtySections.size > 0;

  const handleSave = async () => {
    if (!draft || !baseline || saving) return;
    const api = readNativeApi();
    if (!api?.projectAgent) {
      setSaveError("Project coordinator is unavailable.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const importedInstructions =
      props.mode === "onboarding" &&
      !instructionsSource.serverBacked &&
      instructionsAutosave.value.trim().length > 0
        ? instructionsAutosave.value
        : props.importedInstructions?.trim()
          ? props.importedInstructions
          : undefined;
    const fingerprint = saveAttemptFingerprint({
      mode: props.mode,
      draft,
      importedInstructions,
    });
    const requestId = resolveSaveAttemptRequestId({
      failed: failedAttemptRef.current,
      fingerprint,
    });
    const result = await saveGroupSettings({
      projectId: props.projectId,
      requestId,
      mode: props.mode,
      draft,
      baseline,
      // Edit mode always carries the optimistic-lock token: the baseline config
      // revision when the dialog loaded it, else the summaries store's latest —
      // the dialog can open before the panel (and its overview) ever mounted.
      expectedRevision:
        props.mode === "edit"
          ? (baseline.config?.revision ??
            useProjectAgentSummariesStore.getState().summariesByProjectId.get(props.projectId)
              ?.revision ??
            0)
          : undefined,
      importedInstructions,
      userDisplayName,
      renameProject: async (title) => {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: props.projectId,
          title,
        });
        renameProjectLocally(props.projectId, title);
      },
      configure: (payload) => api.projectAgent.configure(payload),
    });
    setSaving(false);
    if (!result.ok) {
      failedAttemptRef.current = { requestId, fingerprint };
      setSaveError(result.error);
      return;
    }
    failedAttemptRef.current = null;
    useProjectAgentSummariesStore.getState().applyOverview(result.overview);
    void agent.load();
    props.onSaved?.(result.overview);
    props.onOpenChange(false);
  };

  const title = props.mode === "onboarding" ? "Set up your group" : props.projectName;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        // A close mid-save would drop the in-flight optimistic-lock write and
        // leave the draft unrecoverable; only Escape/backdrop while idle counts.
        if (!open && saving) return;
        props.onOpenChange(open);
      }}
    >
      <DialogPopup className="h-[min(80vh,720px)] max-w-4xl">
        <DialogHeader className="border-b border-[color:var(--color-border-light)] px-5 pb-3">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {props.mode === "onboarding"
              ? "Choose how the coordinator works with this group."
              : "Coordinator settings for this group."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label="Group settings sections"
            className="shrink-0 overflow-x-auto border-b border-[color:var(--color-border-light)] px-1.5 py-2 sm:w-[220px] sm:overflow-x-visible sm:overflow-y-auto sm:border-b-0 sm:border-r"
          >
            <ul className={cn("flex flex-row sm:flex-col", SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME)}>
              {GROUP_SETTINGS_SECTIONS.map((id) => {
                const isActive = id === section;
                return (
                  <li key={id} className="shrink-0">
                    <button
                      type="button"
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        SETTINGS_SIDEBAR_ITEM_CLASS_NAME,
                        "whitespace-nowrap",
                        isActive
                          ? SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME
                          : SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME,
                      )}
                      onClick={() => setSection(id)}
                    >
                      <SidebarLeadingIcon size="sm" tone="text-inherit">
                        <CentralIcon
                          name={GROUP_SETTINGS_SECTION_ICONS[id]}
                          className={SETTINGS_SIDEBAR_ICON_CLASS_NAME}
                        />
                      </SidebarLeadingIcon>
                      <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>
                        {GROUP_SETTINGS_SECTION_LABELS[id]}
                      </span>
                      {dirtySections.has(id) ? (
                        <span
                          aria-label="Unsaved changes"
                          className="ms-auto size-1.5 rounded-full bg-muted-foreground/60"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {draft === null ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                {agent.error ? (
                  <p className="text-ui text-destructive" role="alert">
                    {agent.error}
                  </p>
                ) : (
                  <Spinner aria-label="Loading group settings" className="size-4" />
                )}
              </div>
            ) : section === "general" ? (
              <GroupGeneralSection
                draft={draft}
                defaultModelSelection={props.defaultModelSelection}
                projectCwd={props.workspacePath}
                onChange={(patch) =>
                  setDraft((current) => (current ? { ...current, ...patch } : current))
                }
              />
            ) : section === "memory" ? (
              <GroupMemorySection
                configured={agent.overview?.configured === true}
                draft={draft}
                agent={agent}
                instructionsSource={instructionsSource}
                instructionsAutosave={instructionsAutosave}
                onChange={(patch) =>
                  setDraft((current) => (current ? { ...current, ...patch } : current))
                }
              />
            ) : section === "environment" ? (
              <GroupEnvironmentSection
                workspacePath={props.workspacePath}
                draft={draft}
                agent={agent}
                onChange={(patch) =>
                  setDraft((current) => (current ? { ...current, ...patch } : current))
                }
              />
            ) : (
              <GroupPluginsSection workspacePath={props.workspacePath} />
            )}
          </div>
        </div>
        <DialogFooter className="border-t border-[color:var(--color-border-light)] px-5 py-3">
          {saveError ? (
            <p className="me-auto self-center text-ui text-destructive" role="alert">
              {saveError}
            </p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={saving || draft === null || (props.mode === "edit" && !dirty)}
            onClick={() => void handleSave()}
          >
            {props.mode === "onboarding" ? "Create group" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
