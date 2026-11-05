// FILE: BotSheet.tsx
// Purpose: The bot sheet (HoloBot's bots/BotSheet.tsx and BotSheetHost.tsx): a new bot can start
//          from a role (templates) or make the coding crew at once; then its mascot (shape and
//          color), name and role, where it works (every project or some, optionally only some
//          folders), its chat engine and its tasks' engine, whether it starts on its own, its
//          instructions, pinned skills and tile. Create sends `bots.create` (a request id per
//          submit, reused when the same submit is retried); edit sends only what changed with
//          `bots.update` and the revision the sheet opened (Reload merges after a conflict);
//          Remove asks first. SynBot keeps its name, role, scope and look.
// Layer: SynBot editor UI
// Exports: BotSheetHost

import {
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_MASCOT_COLORS,
  BOT_MASCOT_SHAPES,
  BOT_NAME_MAX_LENGTH,
  BOT_PINNED_SKILLS_MAX,
  BOT_ROLE_MAX_LENGTH,
  type Bot,
  type BotAutonomy,
  type BotMascotShape,
  type ModelSelection,
  type ProjectId,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolveSaveAttemptRequestId } from "~/components/chat/group/groupSettingsDialog.logic";
import { buildSettingsSkillGroups } from "~/components/settings/skillsSettingsModel";
import { useTranslation } from "~/i18n";
import { skillsCatalogQueryOptions } from "~/lib/providerDiscoveryReactQuery";
import { isOrdinarySpaceProject } from "~/lib/spaces";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { useOpenBot } from "~/components/synbot/synbotNav";
import { orderedBots } from "~/synbot/synbotState.logic";
import { startSynbotLiveSync, useSynbotStore } from "~/synbot/synbotStore";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

import { BotFace } from "../BotFace";
import { AlertDialog, Dialog } from "../kit/Dialog";
import {
  CapsuleButton,
  Field,
  Segmented,
  Switch,
  TextField,
  type SegmentedOption,
} from "../kit/controls";
import { BotMascot } from "../kit/Mascot";
import { Menu, type MenuEntry } from "../kit/Menu";
import { useEngineMenu } from "../thread/useEngineMenu";
import {
  BOT_EDITOR_CREW_TEMPLATE,
  applyBotTemplate,
  availableBotTemplates,
  blankBotEditorForm,
  botCreateInput,
  botEditorFormFromBot,
  botEditorIssue,
  botUpdateInput,
  crewCreateInputs,
  errorMessageOf,
  findBotTemplate,
  isBotConflictError,
  missingCrewTemplates,
  rebaseBotEditorForm,
  type BotEditorForm,
  type BotScopeMode,
} from "./botEditor.logic";
import { useBotEditor, type BotEditorTarget } from "./botEditorStore";
import { useBotDefaultEngine } from "./useBotDefaultEngine";
import "./bots.css";

/** Every shape a bot may take: all but SynBot's reserved mark. */
const PICKER_SHAPES: readonly BotMascotShape[] = BOT_MASCOT_SHAPES.filter(
  (shape) => shape !== "synara",
);
const COLOR_KEYS = ["blue", "orange", "green", "purple", "red", "teal", "yellow", "gray"] as const;

type SaveError =
  | { readonly kind: "conflict" }
  | { readonly kind: "message"; readonly text: string };

/** Mount once (the SynBot page); open it with `useBotEditor`. */
export function BotSheetHost() {
  const open = useBotEditor((store) => store.open);
  const target = useBotEditor((store) => store.target);
  const session = useBotEditor((store) => store.session);
  const close = useBotEditor((store) => store.close);
  const status = useSynbotStore((store) => store.status);
  const bots = useSynbotStore((store) => store.data.bots);
  const bot =
    target?.mode === "edit" ? (bots.find((entry) => entry.id === target.botId) ?? null) : null;
  const botMissing = open && target?.mode === "edit" && status === "ready" && bot === null;

  useEffect(() => {
    startSynbotLiveSync();
  }, []);
  // The bot was removed elsewhere while its sheet was open.
  useEffect(() => {
    if (botMissing && !useBotEditor.getState().busy) close();
  }, [botMissing, close]);

  if (!open || !target || (target.mode === "edit" && !bot)) return null;
  return <BotSheet key={session} target={target} bot={bot} bots={bots} onClose={close} />;
}

/** Ordinary projects, by name: where a bot can work. */
function useProjects() {
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
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    [chatWorkspaceRoot, groupsWorkspaceRoot, homeDir, projects, studioWorkspaceRoot],
  );
}

function EngineField({
  title,
  hint,
  selection,
  onChange,
  sameAs,
  onSame,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly selection: ModelSelection;
  readonly onChange: (next: ModelSelection) => void;
  /** The task engine: "Same as the chat" first, checked while it follows the chat. */
  readonly sameAs?: { readonly checked: boolean; readonly label: string };
  readonly onSame?: () => void;
}) {
  const engine = useEngineMenu({ selection, onChange });
  const items: MenuEntry[] = sameAs
    ? [
        {
          id: "same",
          label: sameAs.label,
          checked: sameAs.checked,
          onSelect: () => onSame?.(),
        },
        { rule: true },
        ...engine.items,
      ]
    : engine.items;
  return (
    <Field title={title} hint={hint}>
      <Menu
        label={title}
        items={items}
        place="below-start"
        onOpenChange={engine.setOpen}
        trigger={
          <CapsuleButton kind="normal" compact className="bot-sheet__engine">
            {sameAs?.checked ? sameAs.label : engine.label}
          </CapsuleButton>
        }
      />
    </Field>
  );
}

function BotSheet({
  target,
  bot,
  bots,
  onClose,
}: {
  readonly target: BotEditorTarget;
  readonly bot: Bot | null;
  readonly bots: readonly Bot[];
  readonly onClose: () => void;
}) {
  const { t, formatLocale } = useTranslation();
  const openBot = useOpenBot();
  const defaultEngine = useBotDefaultEngine();
  const projects = useProjects();
  const creating = target.mode === "create";
  const main = bot?.kind === "main";
  const blankMascotIndex = bots.filter((entry) => entry.kind !== "main").length;
  const crewMode =
    creating && target.template?.toLowerCase() === BOT_EDITOR_CREW_TEMPLATE.toLowerCase();

  const [opened] = useState<BotEditorForm>(() => {
    if (bot) return botEditorFormFromBot(bot);
    const blank = blankBotEditorForm({
      modelSelection: defaultEngine,
      mascotIndex: blankMascotIndex,
    });
    const template = findBotTemplate(target.mode === "create" ? target.template : null);
    return template ? applyBotTemplate(blank, template) : blank;
  });
  const [form, setForm] = useState(opened);
  const [openedWith, setOpenedWith] = useState(opened);
  const [baseBot, setBaseBot] = useState(bot);
  const [paths, setPaths] = useState(opened.paths.join(", "));
  /** A new bot follows the default engine until one is picked. */
  const [enginePicked, setEnginePicked] = useState(!creating);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  // The last failed create: a retry of the same payload reuses its request id.
  const failedAttemptRef = useRef<{ requestId: string; fingerprint: string } | null>(null);
  const busy = saving || removing;
  useEffect(() => {
    useBotEditor.getState().setBusy(busy);
    return () => useBotEditor.getState().setBusy(false);
  }, [busy]);

  const effective: BotEditorForm = {
    ...(enginePicked ? form : { ...form, modelSelection: defaultEngine }),
    paths: paths.split(","),
  };
  const update = (patch: Partial<BotEditorForm>) => {
    setError(null);
    setForm((current) => ({ ...current, ...patch }));
  };
  const crew = missingCrewTemplates(bots);
  const updateInput = !creating && baseBot ? botUpdateInput(baseBot, effective) : null;
  const issue = crewMode ? null : botEditorIssue(effective);
  const canSave = crewMode ? crew.length > 0 : issue === null && (creating || updateInput !== null);

  const catalogQuery = useQuery(skillsCatalogQueryOptions());
  const skillGroups = useMemo(
    () => buildSettingsSkillGroups(catalogQuery.data?.skills ?? []),
    [catalogQuery.data?.skills],
  );

  const save = async (forCrew = crewMode) => {
    if (busy || (!forCrew && !canSave) || (forCrew && crew.length === 0)) return;
    const api = readNativeApi();
    if (!api) {
      setError({ kind: "message", text: t("synbotEditor:unavailable") });
      return;
    }
    const fingerprint = forCrew
      ? JSON.stringify({ crew: true, modelSelection: effective.modelSelection })
      : JSON.stringify(effective);
    const requestId = resolveSaveAttemptRequestId({
      failed: failedAttemptRef.current,
      fingerprint,
    });
    setSaving(true);
    setError(null);
    try {
      const store = useSynbotStore.getState();
      if (forCrew) {
        for (const input of crewCreateInputs({
          bots,
          modelSelection: effective.modelSelection,
          requestId,
        })) {
          store.applyEvent({ type: "bot-upserted", bot: await api.bots.create(input) });
        }
      } else if (creating) {
        const created = await api.bots.create(botCreateInput(effective, requestId));
        store.applyEvent({ type: "bot-upserted", bot: created });
        openBot(created);
      } else if (updateInput) {
        store.applyEvent({ type: "bot-upserted", bot: await api.bots.update(updateInput) });
      }
      failedAttemptRef.current = null;
      setSaving(false);
      onClose();
    } catch (cause) {
      failedAttemptRef.current = { requestId, fingerprint };
      const text = errorMessageOf(cause);
      setError(isBotConflictError(text) ? { kind: "conflict" } : { kind: "message", text });
      setSaving(false);
    }
  };

  // "Reload and retry": the user's edits onto the bot as it is now.
  const reload = () => {
    if (!bot) return;
    const latest = botEditorFormFromBot(bot);
    const merged = rebaseBotEditorForm({ ...form, paths: paths.split(",") }, openedWith, latest);
    setForm(merged);
    setPaths(
      merged.paths
        .map((path) => path.trim())
        .filter(Boolean)
        .join(", "),
    );
    setOpenedWith(latest);
    setBaseBot(bot);
    setError(null);
  };

  const remove = async () => {
    const api = readNativeApi();
    if (!baseBot || !api || removing) return;
    setRemoving(true);
    try {
      await api.bots.remove({ id: baseBot.id });
      useSynbotStore.getState().applyEvent({ type: "bot-removed", botId: baseBot.id });
      setRemoving(false);
      setConfirmRemove(false);
      const synbot = orderedBots(useSynbotStore.getState().data.bots).main;
      if (synbot) openBot(synbot);
      onClose();
    } catch (cause) {
      setRemoving(false);
      setConfirmRemove(false);
      setError({ kind: "message", text: errorMessageOf(cause) });
    }
  };

  const scopeOptions: SegmentedOption<BotScopeMode>[] = [
    { value: "all", label: t("synbotEditor:allProjects") },
    { value: "chosen", label: t("synbotEditor:chosenProjects") },
  ];
  const autonomyOptions: SegmentedOption<BotAutonomy>[] = [
    { value: "auto", label: t("synbotEditor:autonomyAuto") },
    { value: "ask", label: t("synbotEditor:autonomyAsk") },
  ];
  const pinnedPaths = new Set(effective.pinnedSkills.map((skill) => skill.path));
  const skillItems: MenuEntry[] =
    skillGroups.length === 0
      ? [
          {
            id: "none",
            label: catalogQuery.isLoading
              ? t("synbotEditor:skillsLoading")
              : catalogQuery.isError
                ? t("synbotEditor:skillsFailed")
                : t("synbotEditor:noSkills"),
            disabled: true,
            onSelect: () => undefined,
          },
        ]
      : skillGroups.map((group) => {
          const path = group.primarySkill.path;
          const checked = pinnedPaths.has(path);
          return {
            id: path,
            label: group.displayName,
            checked,
            keepOpen: true,
            disabled: !checked && effective.pinnedSkills.length >= BOT_PINNED_SKILLS_MAX,
            onSelect: () =>
              update({
                pinnedSkills: checked
                  ? effective.pinnedSkills.filter((skill) => skill.path !== path)
                  : [...effective.pinnedSkills, { name: group.primarySkill.name, path }],
              }),
          };
        });
  const chosen = new Set<string>(effective.projectIds);
  const templates = availableBotTemplates(bots);

  const title = crewMode
    ? t("synbotEditor:crewTitle")
    : creating
      ? t("synbotEditor:newTitle")
      : (baseBot?.name ?? t("synbotEditor:editTitle"));

  const footer = (
    <div className="bot-sheet__footer">
      {!creating && !main ? (
        <CapsuleButton kind="danger" compact disabled={busy} onClick={() => setConfirmRemove(true)}>
          {t("synbotEditor:remove")}
        </CapsuleButton>
      ) : null}
      {error ? (
        <span className="bot-sheet__error" role="alert">
          {error.kind === "conflict" ? t("synbotEditor:conflict") : error.text}
          {error.kind === "conflict" && bot ? (
            <CapsuleButton kind="normal" small onClick={reload}>
              {t("synbotEditor:reload")}
            </CapsuleButton>
          ) : null}
        </span>
      ) : null}
      <span className="bot-sheet__spacer" />
      <CapsuleButton kind="ghost" compact disabled={busy} onClick={onClose}>
        {t("common:form_cancel")}
      </CapsuleButton>
      <CapsuleButton kind="primary" compact disabled={busy || !canSave} onClick={() => void save()}>
        {crewMode
          ? t("synbotEditor:createCrew", { count: crew.length })
          : creating
            ? t("synbotEditor:create")
            : t("synbotEditor:save")}
      </CapsuleButton>
    </div>
  );

  return (
    <>
      <Dialog
        open
        onClose={() => !busy && onClose()}
        closable={!busy}
        title={title}
        wide
        footer={footer}
      >
        <div className="bot-sheet">
          {creating ? (
            <div
              className="bot-sheet__templates"
              role="group"
              aria-label={t("synbotEditor:startFrom")}
            >
              <span className="bot-sheet__label">{t("synbotEditor:startFrom")}</span>
              {templates.map((template) => (
                <CapsuleButton
                  key={template.name}
                  kind={!crewMode && form.name === template.name ? "normal" : "ghost"}
                  small
                  chosen={!crewMode && form.name === template.name}
                  onClick={() => {
                    if (crewMode) useBotEditor.getState().openCreate({ template: template.name });
                    else update(applyBotTemplate(form, template));
                  }}
                >
                  <BotMascot
                    shape={template.mascot.shape}
                    color={template.mascot.color}
                    size={14}
                    still
                  />
                  {template.name}
                </CapsuleButton>
              ))}
              {crew.length > 1 && !crewMode ? (
                <CapsuleButton
                  kind="ghost"
                  small
                  title={t("synbotEditor:crewDescription", {
                    names: new Intl.ListFormat(formatLocale).format(
                      crew.map((entry) => entry.name),
                    ),
                  })}
                  disabled={busy}
                  onClick={() => void save(true)}
                >
                  {t("synbotEditor:crewButton", { count: crew.length })}
                </CapsuleButton>
              ) : null}
            </div>
          ) : null}
          {crewMode ? (
            <>
              <p className="bot-sheet__hint">
                {crew.length === 0
                  ? t("synbotEditor:crewComplete")
                  : t("synbotEditor:crewDescription", {
                      names: new Intl.ListFormat(formatLocale).format(
                        crew.map((entry) => entry.name),
                      ),
                    })}
              </p>
              <ul className="bot-sheet__crew">
                {crew.map((template) => (
                  <li key={template.name} className="bot-sheet__crew-row">
                    <BotMascot
                      shape={template.mascot.shape}
                      color={template.mascot.color}
                      size={28}
                    />
                    <span className="bot-sheet__crew-text">
                      <span className="bot-sheet__crew-name">{template.name}</span>
                      <span className="bot-sheet__hint">{template.role}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <EngineField
                title={t("synbotEditor:engine")}
                hint={t("synbotEditor:modelHint")}
                selection={effective.modelSelection}
                onChange={(modelSelection) => {
                  setEnginePicked(true);
                  update({ modelSelection });
                }}
              />
            </>
          ) : (
            <>
              <div className="bot-sheet__look">
                {main && bot ? (
                  <BotFace bot={bot} size={56} mood="idle" />
                ) : (
                  <BotMascot
                    shape={effective.mascot.shape}
                    color={effective.mascot.color}
                    size={56}
                  />
                )}
                {main ? (
                  <p className="bot-sheet__hint">{t("synbotEditor:mainDescription")}</p>
                ) : (
                  <div className="bot-sheet__pickers">
                    <div
                      className="bot-sheet__row"
                      role="radiogroup"
                      aria-label={t("synbotEditor:shape")}
                    >
                      {PICKER_SHAPES.map((shape) => (
                        <button
                          key={shape}
                          type="button"
                          role="radio"
                          aria-checked={effective.mascot.shape === shape}
                          aria-label={t(`synbotEditor:shape_${shape}`)}
                          title={t(`synbotEditor:shape_${shape}`)}
                          className="bot-sheet__swatch"
                          onClick={() => update({ mascot: { ...effective.mascot, shape } })}
                        >
                          <BotMascot shape={shape} color={effective.mascot.color} size={22} still />
                        </button>
                      ))}
                    </div>
                    <div
                      className="bot-sheet__row"
                      role="radiogroup"
                      aria-label={t("synbotEditor:color")}
                    >
                      {BOT_MASCOT_COLORS.map((color, index) => (
                        <button
                          key={color}
                          type="button"
                          role="radio"
                          aria-checked={effective.mascot.color === color}
                          aria-label={t(`synbotEditor:color_${COLOR_KEYS[index] ?? "gray"}`)}
                          title={t(`synbotEditor:color_${COLOR_KEYS[index] ?? "gray"}`)}
                          className="bot-sheet__color"
                          style={{ background: color }}
                          onClick={() => update({ mascot: { ...effective.mascot, color } })}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="bot-sheet__pair">
                <Field title={t("synbotEditor:name")}>
                  <TextField
                    value={effective.name}
                    onChange={(name) => update({ name })}
                    placeholder={t("synbotEditor:namePlaceholder")}
                    disabled={main}
                    maxLength={BOT_NAME_MAX_LENGTH}
                    aria-label={t("synbotEditor:name")}
                  />
                </Field>
                <Field title={t("synbotEditor:role")}>
                  <TextField
                    value={effective.role}
                    onChange={(role) => update({ role })}
                    placeholder={t("synbotEditor:rolePlaceholder")}
                    disabled={main}
                    maxLength={BOT_ROLE_MAX_LENGTH}
                    aria-label={t("synbotEditor:role")}
                  />
                </Field>
              </div>
              {!main ? (
                <Field
                  title={t("synbotEditor:scopeSection")}
                  hint={t("synbotEditor:projectsDescription")}
                >
                  <Segmented
                    label={t("synbotEditor:scopeSection")}
                    value={effective.scopeMode}
                    options={scopeOptions}
                    onChange={(scopeMode) => update({ scopeMode })}
                  />
                  {effective.scopeMode === "chosen" ? (
                    <div className="bot-sheet__repos">
                      {projects.length === 0 ? (
                        <span className="bot-sheet__hint">{t("synbotEditor:noProjects")}</span>
                      ) : null}
                      {projects.map((project) => {
                        const on = chosen.has(project.id);
                        return (
                          <CapsuleButton
                            key={project.id}
                            kind={on ? "normal" : "ghost"}
                            small
                            chosen={on}
                            aria-pressed={on}
                            onClick={() =>
                              update({
                                projectIds: on
                                  ? effective.projectIds.filter((id) => id !== project.id)
                                  : [...effective.projectIds, project.id as ProjectId],
                              })
                            }
                          >
                            {project.name}
                          </CapsuleButton>
                        );
                      })}
                    </div>
                  ) : null}
                  <TextField
                    value={paths}
                    onChange={(next) => {
                      setError(null);
                      setPaths(next);
                    }}
                    placeholder={t("synbotEditor:pathsPlaceholder")}
                    aria-label={t("synbotEditor:paths")}
                  />
                </Field>
              ) : null}
              <div className="bot-sheet__pair">
                <EngineField
                  title={t("synbotEditor:engine")}
                  hint={t("synbotEditor:modelHint")}
                  selection={effective.modelSelection}
                  onChange={(modelSelection) => {
                    setEnginePicked(true);
                    update({ modelSelection });
                  }}
                />
                <EngineField
                  title={t("synbotEditor:taskEngine")}
                  selection={effective.taskModelSelection ?? effective.modelSelection}
                  onChange={(taskModelSelection) => update({ taskModelSelection })}
                  sameAs={{
                    checked: effective.taskModelSelection === null,
                    label: t("synbotEditor:sameTaskEngine"),
                  }}
                  onSame={() => update({ taskModelSelection: null })}
                />
              </div>
              <Field
                title={t("synbotEditor:autonomy")}
                hint={t("synbotEditor:autonomyDescription")}
              >
                <Segmented
                  label={t("synbotEditor:autonomy")}
                  value={effective.autonomy}
                  options={autonomyOptions}
                  onChange={(autonomy) => update({ autonomy })}
                />
              </Field>
              <Field
                title={t("synbotEditor:instructions")}
                hint={t("synbotEditor:instructionsHelper")}
              >
                <textarea
                  className="bot-sheet__instructions"
                  value={effective.instructions}
                  maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
                  rows={5}
                  placeholder={t("synbotEditor:instructionsPlaceholder")}
                  aria-label={t("synbotEditor:instructions")}
                  onChange={(event) => update({ instructions: event.target.value })}
                />
              </Field>
              <div className="bot-sheet__pair">
                <Field title={t("synbotEditor:skills")} hint={t("synbotEditor:skillsDescription")}>
                  <Menu
                    label={t("synbotEditor:chooseSkills")}
                    items={skillItems}
                    place="below-start"
                    trigger={
                      <CapsuleButton kind="normal" compact className="bot-sheet__engine">
                        {effective.pinnedSkills.length > 0
                          ? effective.pinnedSkills.map((skill) => skill.name).join(", ")
                          : t("synbotEditor:chooseSkills")}
                      </CapsuleButton>
                    }
                  />
                </Field>
                {!main ? (
                  <Field
                    title={t("synbotEditor:pinned")}
                    hint={t("synbotEditor:pinnedDescription")}
                  >
                    <Switch
                      checked={effective.pinned}
                      ariaLabel={t("synbotEditor:pinned")}
                      onChange={(pinned) => update({ pinned })}
                    />
                  </Field>
                ) : null}
              </div>
              {issue === "projects-required" ? (
                <p className="bot-sheet__error">{t("synbotEditor:projectsRequired")}</p>
              ) : null}
            </>
          )}
        </div>
      </Dialog>
      <AlertDialog
        open={confirmRemove}
        title={t("synbotEditor:removeTitle", { value0: baseBot?.name ?? "" })}
        message={t("synbotEditor:removeMessage")}
        confirmLabel={t("synbotEditor:remove")}
        danger
        busy={removing}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </>
  );
}
