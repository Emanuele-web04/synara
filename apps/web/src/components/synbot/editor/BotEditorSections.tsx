// FILE: BotEditorSections.tsx
// Purpose: The bot editor's grouped settings cards: identity (look, name, role, instructions),
//          scope (projects and path globs), engine (chat and task models through the app's
//          model picker rows) and behavior (autonomy, pinned skills, tile).
// Layer: SynBot editor UI
// Exports: BotIdentitySection, BotScopeSection, BotEngineSection, BotBehaviorSection

import {
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_PINNED_SKILLS_MAX,
  BOT_ROLE_MAX_LENGTH,
  BOT_SCOPE_PATHS_MAX,
  type BotAutonomy,
  type ModelSelection,
  type ProjectId,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { CharacterCountTextarea } from "~/components/chat/group/CharacterCountTextarea";
import { GroupEffortRow, GroupModelRow } from "~/components/chat/group/GroupModelEffortRow";
import {
  SettingsSegmentedControl,
  type SettingsSegmentedOption,
} from "~/components/settings/SettingControls";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { buildSettingsSkillGroups } from "~/components/settings/skillsSettingsModel";
import { abbreviateHomePath } from "~/components/sidebarHoverCardAnchors";
import { Button } from "~/components/ui/button";
import { dialogFieldLabelClassName } from "~/components/ui/dialog";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { useTranslation } from "~/i18n";
import { skillsCatalogQueryOptions } from "~/lib/providerDiscoveryReactQuery";
import { isOrdinarySpaceProject } from "~/lib/spaces";
import { AddPlusIcon, XIcon } from "~/lib/icons";
import { SETTINGS_CARD_ROW_CLASS_NAME } from "~/settingsPanelStyles";
import { useStore } from "~/store";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

import type { BotEditorForm, BotScopeMode } from "./botEditor.logic";
import { BotChecklistChips, BotChecklistMenu, type BotChecklistItem } from "./BotChecklistMenu";
import { BotMascotPicker } from "./BotMascotPicker";

type FormPatch = (patch: Partial<BotEditorForm>) => void;

const SCOPE_OPTIONS: readonly SettingsSegmentedOption<BotScopeMode>[] = [
  { value: "all", label: "synbotEditor:allProjects" },
  { value: "chosen", label: "synbotEditor:chosenProjects" },
];

const AUTONOMY_OPTIONS: readonly SettingsSegmentedOption<BotAutonomy>[] = [
  { value: "auto", label: "synbotEditor:autonomyAuto" },
  { value: "ask", label: "synbotEditor:autonomyAsk" },
];

const toggle = <T,>(items: readonly T[], item: T): T[] =>
  items.includes(item) ? items.filter((entry) => entry !== item) : [...items, item];

// ── Identity ─────────────────────────────────────────────────────────

export function BotIdentitySection(props: {
  readonly form: BotEditorForm;
  /** SynBot: name, role and shape are fixed. */
  readonly main: boolean;
  readonly onChange: FormPatch;
}) {
  const { t } = useTranslation();
  const { form, main, onChange } = props;
  return (
    <SettingsSectionShell title="synbotEditor:identitySection">
      <SettingsCard>
        <div className={SETTINGS_CARD_ROW_CLASS_NAME}>
          <BotMascotPicker
            mascot={form.mascot}
            shapeLocked={main}
            onChange={(mascot) => onChange({ mascot })}
          />
        </div>
        <div className={`${SETTINGS_CARD_ROW_CLASS_NAME} grid gap-3 sm:grid-cols-2`}>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={dialogFieldLabelClassName}>{t("synbotEditor:name")}</span>
            <Input
              value={form.name}
              maxLength={BOT_NAME_MAX_LENGTH}
              disabled={main}
              placeholder={t("synbotEditor:namePlaceholder")}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={dialogFieldLabelClassName}>{t("synbotEditor:role")}</span>
            <Input
              value={form.role}
              maxLength={BOT_ROLE_MAX_LENGTH}
              disabled={main}
              placeholder={t("synbotEditor:rolePlaceholder")}
              onChange={(event) => onChange({ role: event.target.value })}
            />
          </label>
        </div>
        <div className={`${SETTINGS_CARD_ROW_CLASS_NAME} flex flex-col gap-1.5`}>
          <span className={dialogFieldLabelClassName}>{t("synbotEditor:instructions")}</span>
          <CharacterCountTextarea
            value={form.instructions}
            maxChars={BOT_INSTRUCTIONS_MAX_LENGTH}
            helper={t("synbotEditor:instructionsHelper")}
            placeholder={t("synbotEditor:instructionsPlaceholder")}
            aria-label={t("synbotEditor:instructions")}
            onChange={(event) => onChange({ instructions: event.target.value })}
          />
        </div>
      </SettingsCard>
    </SettingsSectionShell>
  );
}

// ── Scope ────────────────────────────────────────────────────────────

function useOrdinaryProjectItems(): readonly BotChecklistItem[] {
  const projects = useStore((store) => store.projects);
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((state) => state.groupsWorkspaceRoot);
  return useMemo(
    () =>
      projects
        .filter((project) =>
          isOrdinarySpaceProject(project, {
            homeDir,
            chatWorkspaceRoot,
            studioWorkspaceRoot,
            groupsWorkspaceRoot,
          }),
        )
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((project) => ({
          id: project.id,
          label: project.name,
          detail: abbreviateHomePath(project.cwd, homeDir),
        })),
    [chatWorkspaceRoot, groupsWorkspaceRoot, homeDir, projects, studioWorkspaceRoot],
  );
}

export function BotScopeSection(props: {
  readonly form: BotEditorForm;
  /** SynBot works in every project. */
  readonly main: boolean;
  readonly onChange: FormPatch;
}) {
  const { t } = useTranslation();
  const { form, main, onChange } = props;
  const projectItems = useOrdinaryProjectItems();
  const chosen = new Set<string>(form.projectIds);
  const chosenItems = form.projectIds.map(
    (id) =>
      projectItems.find((item) => item.id === id) ?? {
        id,
        label: t("synbotEditor:removedProject"),
      },
  );
  const setPath = (index: number, value: string) =>
    onChange({ paths: form.paths.map((path, at) => (at === index ? value : path)) });
  return (
    <SettingsSectionShell title="synbotEditor:scopeSection">
      <fieldset disabled={main} className="contents">
        <SettingsCard>
          <SettingsRow
            title="synbotEditor:projects"
            description={main ? "synbotEditor:mainScope" : "synbotEditor:projectsDescription"}
            control={
              <SettingsSegmentedControl
                value={form.scopeMode}
                options={SCOPE_OPTIONS}
                ariaLabel={t("synbotEditor:projects")}
                onValueChange={(scopeMode) => onChange({ scopeMode })}
              />
            }
          >
            <DisclosureRegion open={form.scopeMode === "chosen"}>
              <div className="flex flex-col items-start gap-1 pt-2">
                <BotChecklistMenu
                  triggerLabel={
                    form.projectIds.length === 0
                      ? t("synbotEditor:chooseProjects")
                      : t("synbotEditor:projectCount", { count: form.projectIds.length })
                  }
                  ariaLabel={t("synbotEditor:chooseProjects")}
                  items={projectItems}
                  selectedIds={chosen}
                  emptyLabel={t("synbotEditor:noProjects")}
                  onToggle={(id) =>
                    onChange({ projectIds: toggle(form.projectIds, id as ProjectId) })
                  }
                />
                <BotChecklistChips
                  items={chosenItems}
                  removeLabel={(item) => t("synbotEditor:removeItem", { value0: item.label })}
                  onRemove={(id) =>
                    onChange({ projectIds: form.projectIds.filter((entry) => entry !== id) })
                  }
                />
                {form.projectIds.length === 0 ? (
                  <p className="pt-1 text-ui-sm text-muted-foreground">
                    {t("synbotEditor:projectsRequired")}
                  </p>
                ) : null}
              </div>
            </DisclosureRegion>
          </SettingsRow>
          <SettingsRow
            title="synbotEditor:paths"
            description="synbotEditor:pathsDescription"
            control={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={form.paths.length >= BOT_SCOPE_PATHS_MAX}
                onClick={() => onChange({ paths: [...form.paths, ""] })}
              >
                <AddPlusIcon aria-hidden className="size-3.5" />
                {t("synbotEditor:addPath")}
              </Button>
            }
          >
            {form.paths.length > 0 ? (
              <ul className="flex flex-col gap-1.5 pt-2">
                {form.paths.map((path, index) => (
                  // Rows are positional and fully controlled; an index key keeps focus while typing.
                  // oxlint-disable-next-line react/no-array-index-key
                  <li key={index} className="flex items-center gap-1.5">
                    <Input
                      value={path}
                      size="sm"
                      maxLength={256}
                      placeholder={t("synbotEditor:pathPlaceholder")}
                      aria-label={t("synbotEditor:pathRow", { value0: index + 1 })}
                      className="font-mono"
                      onChange={(event) => setPath(index, event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("synbotEditor:removeItem", {
                        value0: path.trim() || t("synbotEditor:pathRow", { value0: index + 1 }),
                      })}
                      onClick={() =>
                        onChange({ paths: form.paths.filter((_, at) => at !== index) })
                      }
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </SettingsRow>
        </SettingsCard>
      </fieldset>
    </SettingsSectionShell>
  );
}

// ── Engine ───────────────────────────────────────────────────────────

export function BotEngineSection(props: {
  readonly modelSelection: ModelSelection;
  readonly taskModelSelection: ModelSelection | null;
  /** "Use default" target of the chat engine row; null hides the link. */
  readonly defaultSelection: ModelSelection | null;
  /** The crew sheet sets one engine for every bot: no task engine. */
  readonly showTaskEngine: boolean;
  readonly onModelChange: (next: ModelSelection) => void;
  readonly onTaskModelChange: (next: ModelSelection | null) => void;
}) {
  const { t } = useTranslation();
  const sameAsChat = props.taskModelSelection === null;
  // While the task rows fold away they keep showing the chat's engine.
  const taskSelection = props.taskModelSelection ?? props.modelSelection;
  return (
    <SettingsSectionShell title="synbotEditor:engineSection">
      <SettingsCard>
        <GroupModelRow
          title={t("synbotEditor:engine")}
          description={t("synbotEditor:engineDescription")}
          selection={props.modelSelection}
          defaultSelection={props.defaultSelection}
          projectCwd=""
          onChange={props.onModelChange}
        />
        <GroupEffortRow
          title={t("synbotEditor:effort")}
          description={t("synbotEditor:effortDescription")}
          selection={props.modelSelection}
          projectCwd=""
          onChange={props.onModelChange}
        />
        {props.showTaskEngine ? (
          <SettingsRow
            title="synbotEditor:sameTaskEngine"
            description="synbotEditor:sameTaskEngineDescription"
            control={
              <Switch
                checked={sameAsChat}
                aria-label={t("synbotEditor:sameTaskEngine")}
                onCheckedChange={(checked) =>
                  props.onTaskModelChange(checked ? null : props.modelSelection)
                }
              />
            }
          />
        ) : null}
      </SettingsCard>
      {props.showTaskEngine ? (
        <DisclosureRegion open={!sameAsChat}>
          <SettingsCard>
            <GroupModelRow
              title={t("synbotEditor:taskEngine")}
              description={t("synbotEditor:taskEngineDescription")}
              selection={taskSelection}
              defaultSelection={null}
              projectCwd=""
              onChange={props.onTaskModelChange}
            />
            <GroupEffortRow
              title={t("synbotEditor:taskEffort")}
              description={t("synbotEditor:taskEffortDescription")}
              selection={taskSelection}
              projectCwd=""
              onChange={props.onTaskModelChange}
            />
          </SettingsCard>
        </DisclosureRegion>
      ) : null}
    </SettingsSectionShell>
  );
}

// ── Behavior ─────────────────────────────────────────────────────────

export function BotBehaviorSection(props: {
  readonly form: BotEditorForm;
  /** SynBot always leads the panel: no tile switch. */
  readonly main: boolean;
  readonly onChange: FormPatch;
}) {
  const { t } = useTranslation();
  const { form, onChange } = props;
  const catalogQuery = useQuery(skillsCatalogQueryOptions());
  const catalogSkills = catalogQuery.data?.skills;
  const skillGroups = useMemo(() => buildSettingsSkillGroups(catalogSkills ?? []), [catalogSkills]);
  const skillItems = skillGroups.map((group) => ({
    id: group.primarySkill.path,
    label: group.displayName,
    detail: group.primarySkill.path,
  }));
  const pinnedPaths = new Set(form.pinnedSkills.map((skill) => skill.path));
  const toggleSkill = (path: string) => {
    if (pinnedPaths.has(path)) {
      onChange({ pinnedSkills: form.pinnedSkills.filter((skill) => skill.path !== path) });
      return;
    }
    const group = skillGroups.find((entry) => entry.primarySkill.path === path);
    if (!group) return;
    onChange({
      pinnedSkills: [...form.pinnedSkills, { name: group.primarySkill.name, path }],
    });
  };
  return (
    <SettingsSectionShell title="synbotEditor:behaviorSection">
      <SettingsCard>
        <SettingsRow
          title="synbotEditor:autonomy"
          description="synbotEditor:autonomyDescription"
          control={
            <SettingsSegmentedControl
              value={form.autonomy}
              options={AUTONOMY_OPTIONS}
              ariaLabel={t("synbotEditor:autonomy")}
              onValueChange={(autonomy) => onChange({ autonomy })}
            />
          }
        />
        <SettingsRow
          title="synbotEditor:skills"
          description="synbotEditor:skillsDescription"
          control={
            <BotChecklistMenu
              triggerLabel={
                catalogQuery.isLoading
                  ? t("synbotEditor:skillsLoading")
                  : t("synbotEditor:chooseSkills")
              }
              ariaLabel={t("synbotEditor:chooseSkills")}
              items={skillItems}
              selectedIds={pinnedPaths}
              emptyLabel={
                catalogQuery.isError ? t("synbotEditor:skillsFailed") : t("synbotEditor:noSkills")
              }
              full={form.pinnedSkills.length >= BOT_PINNED_SKILLS_MAX}
              onToggle={toggleSkill}
            />
          }
        >
          <BotChecklistChips
            items={form.pinnedSkills.map((skill) => ({
              id: skill.path,
              label: skill.name,
              detail: skill.path,
            }))}
            removeLabel={(item) => t("synbotEditor:removeItem", { value0: item.label })}
            onRemove={toggleSkill}
          />
        </SettingsRow>
        {props.main ? null : (
          <SettingsRow
            title="synbotEditor:pinned"
            description="synbotEditor:pinnedDescription"
            control={
              <Switch
                checked={form.pinned}
                aria-label={t("synbotEditor:pinned")}
                onCheckedChange={(checked) => onChange({ pinned: checked })}
              />
            }
          />
        )}
      </SettingsCard>
    </SettingsSectionShell>
  );
}
