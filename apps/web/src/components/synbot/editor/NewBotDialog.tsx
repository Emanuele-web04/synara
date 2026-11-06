// FILE: NewBotDialog.tsx
// Purpose: New bot in steps (Paper "11 New bot", variant A), one question per screen under a thin
//          progress line: which computer (only with more than one; a bot lives where it is
//          created, so another computer opens its own SynBot page at the Bot step), who it is
//          (look, name, role, or a template), and where it starts (projects, engine, new work,
//          instructions; each a row that opens a menu). Those are only defaults: in its chat the user can ask it to work in
//          another project or on another engine. Create on the last step sends `bots.create`
//          (one request id per submit, reused when the same submit is retried).
// Layer: SynBot editor UI
// Exports: NewBotDialog

import {
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_ROLE_MAX_LENGTH,
  type Bot,
  type BotAutonomy,
  type ProjectId,
} from "@synara/contracts";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { resolveSaveAttemptRequestId } from "~/components/chat/group/groupSettingsDialog.logic";
import { useWorkspaceComputers } from "~/components/hosts/ComputerPicker";
import { ProjectSidebarIcon } from "~/components/ProjectSidebarIcon";
import { ProviderIcon } from "~/components/ProviderIcon";
import { useOpenBot } from "~/components/synbot/synbotNav";
import { useTranslation } from "~/i18n";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleQuestionIcon,
  MonitorIcon,
  PlayIcon,
  PlusIcon,
} from "~/lib/icons";
import { readNativeApi } from "~/nativeApi";
import { useSynbotStore } from "~/synbot/synbotStore";

import { Dialog } from "../kit/Dialog";
import { CapsuleButton, Dot } from "../kit/controls";
import { BotMascot } from "../kit/Mascot";
import { Menu, type MenuEntry } from "../kit/Menu";
import { useEngineMenu } from "../thread/useEngineMenu";
import {
  BOT_EDITOR_CREW_TEMPLATE,
  applyBotTemplate,
  availableBotTemplates,
  blankBotEditorForm,
  botCreateInput,
  errorMessageOf,
  findBotTemplate,
  missingCrewTemplates,
  type BotEditorForm,
} from "./botEditor.logic";
import { useBotEditor, type BotEditorTarget } from "./botEditorStore";
import { MascotPicker } from "./MascotPicker";
import {
  chooseAllProjects,
  newBotStepIssue,
  newBotSteps,
  projectsSummary,
  toggleBotProject,
  type NewBotStep,
} from "./newBot.logic";
import { useBotDefaultEngine } from "./useBotDefaultEngine";
import { useBotProjects } from "./useBotProjects";
import "./bots.css";
import "./newBot.css";

/** The SynBot page with New bot open at the Bot step (`?new=bot`). */
const NEW_BOT_PATH = "/synbot?new=bot";

type CreateTarget = Extract<BotEditorTarget, { readonly mode: "create" }>;

export function NewBotDialog({
  target,
  bots,
  onClose,
}: {
  readonly target: CreateTarget;
  readonly bots: readonly Bot[];
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const openBot = useOpenBot();
  const defaultEngine = useBotDefaultEngine();
  const projects = useBotProjects();
  const { computers, localId, currentId, openOn } = useWorkspaceComputers();
  const steps = newBotSteps(
    readExecutionContext()?.controller.capabilities.remoteConnections === true &&
      computers.length > 1,
  );

  const [chosenStep, setStep] = useState<NewBotStep>(() => target.startAt ?? "computer");
  // A computer that goes away (or the only one) leaves the steps without the Computer step.
  const step = steps.includes(chosenStep) ? chosenStep : "bot";
  const index = steps.indexOf(step);
  const [computerId, setComputerId] = useState(currentId);
  const [form, setForm] = useState<BotEditorForm>(() => {
    const blank = blankBotEditorForm({
      modelSelection: defaultEngine,
      mascotIndex: bots.filter((entry) => entry.kind !== "main").length,
    });
    const template = findBotTemplate(target.template);
    return template ? applyBotTemplate(blank, template) : blank;
  });
  /** A new bot follows the default engine until one is picked. */
  const [enginePicked, setEnginePicked] = useState(false);
  /** "open": shown since the step opened (a template's); "added": the user just asked for it. */
  const [instructions, setInstructions] = useState<"closed" | "open" | "added">(
    form.instructions.length > 0 ? "open" : "closed",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last failed create: a retry of the same payload reuses its request id.
  const failedAttemptRef = useRef<{ requestId: string; fingerprint: string } | null>(null);
  useEffect(() => {
    useBotEditor.getState().setBusy(saving);
    return () => useBotEditor.getState().setBusy(false);
  }, [saving]);

  const effective: BotEditorForm = enginePicked ? form : { ...form, modelSelection: defaultEngine };
  const issue = newBotStepIssue(step, effective);
  const last = index === steps.length - 1;
  const update = (patch: Partial<BotEditorForm>) => {
    setError(null);
    setForm((current) => ({ ...current, ...patch }));
  };

  const create = async () => {
    if (saving || issue) return;
    const api = readNativeApi();
    if (!api) {
      setError(t("synbotEditor:unavailable"));
      return;
    }
    const fingerprint = JSON.stringify(effective);
    const requestId = resolveSaveAttemptRequestId({
      failed: failedAttemptRef.current,
      fingerprint,
    });
    setSaving(true);
    setError(null);
    try {
      const created = await api.bots.create(botCreateInput(effective, requestId));
      useSynbotStore.getState().applyEvent({ type: "bot-upserted", bot: created });
      failedAttemptRef.current = null;
      setSaving(false);
      onClose();
      openBot(created);
    } catch (cause) {
      failedAttemptRef.current = { requestId, fingerprint };
      setError(errorMessageOf(cause));
      setSaving(false);
    }
  };

  const next = () => {
    if (saving || issue) return;
    // Another computer makes the bot on its own page.
    if (step === "computer" && computerId !== currentId) {
      if (openOn(computerId, NEW_BOT_PATH)) onClose();
      return;
    }
    const following = steps[index + 1];
    if (following) setStep(following);
    else void create();
  };
  const back = () => {
    const previous = steps[index - 1];
    if (previous) setStep(previous);
    else onClose();
  };

  const question =
    step === "computer"
      ? { title: t("synbotEditor:computerQuestion"), hint: t("synbotEditor:computerHint") }
      : step === "bot"
        ? { title: t("synbotEditor:botQuestion"), hint: t("synbotEditor:botHint") }
        : { title: t("synbotEditor:startQuestion"), hint: t("synbotEditor:startHint") };

  const footer = (
    <div className="bot-sheet__footer new-bot__footer">
      {error ? (
        <span className="bot-sheet__error" role="alert">
          {error}
        </span>
      ) : null}
      <span className="bot-sheet__spacer" />
      <CapsuleButton kind="ghost" disabled={saving} onClick={back}>
        {index === 0 ? t("common:form_cancel") : t("common:app_back")}
      </CapsuleButton>
      <CapsuleButton kind="primary" disabled={saving || issue !== null} onClick={next}>
        {last
          ? t("synbotEditor:createNamed", { value0: effective.name.trim() })
          : t("synbotEditor:continue")}
      </CapsuleButton>
    </div>
  );

  return (
    <Dialog
      open
      onClose={() => !saving && onClose()}
      closable={!saving}
      title={<span className="new-bot__eyebrow">{t("synbotEditor:newTitle")}</span>}
      footer={footer}
    >
      <div className="new-bot">
        <div
          className="new-bot__progress"
          role="progressbar"
          aria-label={t("synbotEditor:stepOf", { current: index + 1, total: steps.length })}
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-valuenow={index + 1}
        >
          <span style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
        </div>
        <div className="new-bot__question">
          <h2 className="new-bot__title">{question.title}</h2>
          <p className="new-bot__hint">{question.hint}</p>
        </div>
        {step === "computer" ? (
          <ComputerStep
            computers={computers}
            localId={localId}
            value={computerId}
            onChange={setComputerId}
          />
        ) : step === "bot" ? (
          <BotStep form={effective} bots={bots} onChange={update} onEnter={next} />
        ) : (
          <StartStep
            form={effective}
            projects={projects}
            instructions={instructions}
            onAddInstructions={() => setInstructions("added")}
            onChange={update}
            onEngine={(modelSelection) => {
              setEnginePicked(true);
              update({ modelSelection });
            }}
          />
        )}
        {step === "start" && issue === "projects-required" ? (
          <p className="bot-sheet__error">{t("synbotEditor:projectsRequired")}</p>
        ) : null}
      </div>
    </Dialog>
  );
}

function ComputerStep({
  computers,
  localId,
  value,
  onChange,
}: {
  readonly computers: ReturnType<typeof useWorkspaceComputers>["computers"];
  readonly localId: string;
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="new-bot__computers" role="radiogroup" aria-label={t("synbotEditor:computer")}>
      {computers.map((computer) => {
        // This computer's detail is its name; a connected one's detail is its connection.
        const here = computer.id === localId;
        const chosen = computer.id === value;
        return (
          <button
            key={computer.id}
            type="button"
            role="radio"
            aria-checked={chosen}
            disabled={!computer.available}
            className="new-bot__computer"
            onClick={() => onChange(computer.id)}
          >
            <span className="new-bot__computer-icon">
              <MonitorIcon className="size-5" />
            </span>
            <span className="new-bot__computer-text">
              <span className="new-bot__computer-name">
                {here ? computer.detail : computer.label}
              </span>
              <span className="new-bot__computer-meta">
                <Dot tone={computer.available ? "good" : "muted"} small />
                {here ? computer.label : computer.detail}
              </span>
            </span>
            <span className="new-bot__radio" aria-hidden>
              {chosen ? <CheckIcon className="size-3" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function BotStep({
  form,
  bots,
  onChange,
  onEnter,
}: {
  readonly form: BotEditorForm;
  readonly bots: readonly Bot[];
  readonly onChange: (patch: Partial<BotEditorForm>) => void;
  readonly onEnter: () => void;
}) {
  const { t } = useTranslation();
  const templates = availableBotTemplates(bots);
  const crew = missingCrewTemplates(bots);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onEnter();
  };
  return (
    <>
      <div className="new-bot__identity">
        <span className="new-bot__face">
          <BotMascot shape={form.mascot.shape} color={form.mascot.color} size={56} />
        </span>
        <div className="new-bot__fields">
          <input
            className="new-bot__name"
            value={form.name}
            placeholder={t("synbotEditor:namePlaceholder")}
            maxLength={BOT_NAME_MAX_LENGTH}
            aria-label={t("synbotEditor:name")}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the step's one question
            autoFocus
            onChange={(event) => onChange({ name: event.target.value })}
            onKeyDown={onKeyDown}
          />
          <input
            className="new-bot__role"
            value={form.role}
            placeholder={t("synbotEditor:rolePlaceholder")}
            maxLength={BOT_ROLE_MAX_LENGTH}
            aria-label={t("synbotEditor:role")}
            onChange={(event) => onChange({ role: event.target.value })}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
      <MascotPicker mascot={form.mascot} onChange={(mascot) => onChange({ mascot })} />
      {templates.length > 0 || crew.length > 1 ? (
        <div className="new-bot__templates" role="group" aria-label={t("synbotEditor:orStartFrom")}>
          <span className="new-bot__templates-label">{t("synbotEditor:orStartFrom")}</span>
          {templates.map((template) => {
            const chosen = form.name === template.name;
            return (
              <CapsuleButton
                key={template.name}
                kind={chosen ? "normal" : "ghost"}
                compact
                chosen={chosen}
                onClick={() => onChange(applyBotTemplate(form, template))}
              >
                <BotMascot
                  shape={template.mascot.shape}
                  color={template.mascot.color}
                  size={14}
                  still
                />
                {template.name}
              </CapsuleButton>
            );
          })}
          {crew.length > 1 ? (
            <CapsuleButton
              kind="ghost"
              compact
              onClick={() =>
                useBotEditor.getState().openCreate({ template: BOT_EDITOR_CREW_TEMPLATE })
              }
            >
              {t("synbotEditor:crewButton", { count: crew.length })}
            </CapsuleButton>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function StartStep({
  form,
  projects,
  instructions,
  onAddInstructions,
  onChange,
  onEngine,
}: {
  readonly form: BotEditorForm;
  readonly projects: ReturnType<typeof useBotProjects>;
  readonly instructions: "closed" | "open" | "added";
  readonly onAddInstructions: () => void;
  readonly onChange: (patch: Partial<BotEditorForm>) => void;
  readonly onEngine: (selection: BotEditorForm["modelSelection"]) => void;
}) {
  const { t } = useTranslation();
  const engine = useEngineMenu({
    selection: form.modelSelection,
    onChange: onEngine,
    withProviderIcons: true,
  });
  const summary = projectsSummary(form, projects);
  const chosen = new Set<string>(form.projectIds);
  const projectItems: MenuEntry[] =
    projects.length === 0
      ? [
          {
            id: "none",
            label: t("synbotEditor:noProjects"),
            disabled: true,
            onSelect: () => undefined,
          },
        ]
      : [
          {
            id: "all",
            label: t("synbotEditor:allProjects"),
            checked: form.scopeMode === "all",
            onSelect: () => onChange(chooseAllProjects()),
          },
          { rule: true },
          ...projects.map((project) => ({
            id: project.id,
            label: project.name,
            glyph: (
              <ProjectSidebarIcon
                cwd={project.cwd}
                expanded={false}
                appearance={project.appearance}
              />
            ),
            checked: form.scopeMode === "chosen" && chosen.has(project.id),
            keepOpen: true,
            onSelect: () => onChange(toggleBotProject(form, project.id as ProjectId)),
          })),
        ];
  const autonomyChoices: readonly {
    readonly value: BotAutonomy;
    readonly label: string;
    readonly detail: string;
    readonly glyph: ReactNode;
  }[] = [
    {
      value: "auto",
      label: t("synbotEditor:autonomyAuto"),
      detail: t("synbotEditor:autonomyAutoDetail"),
      glyph: <PlayIcon className="size-3.5" />,
    },
    {
      value: "ask",
      label: t("synbotEditor:autonomyAskShort"),
      detail: t("synbotEditor:autonomyAskDetail"),
      glyph: <CircleQuestionIcon className="size-4" />,
    },
  ];
  const autonomy = autonomyChoices.find((choice) => choice.value === form.autonomy);
  const autonomyItems: MenuEntry[] = autonomyChoices.map((choice) => ({
    id: choice.value,
    label: choice.label,
    detail: choice.detail,
    glyph: choice.glyph,
    checked: form.autonomy === choice.value,
    onSelect: () => onChange({ autonomy: choice.value }),
  }));
  const shown = summary.all ? [] : summary.chosen.slice(0, 2);
  const more = summary.all ? 0 : summary.chosen.length - shown.length;

  return (
    <div className="new-bot__defaults">
      <Menu
        label={t("synbotEditor:projects")}
        items={projectItems}
        place="below-end"
        trigger={
          <button type="button" className="new-bot__row">
            <span className="new-bot__label">{t("synbotEditor:projects")}</span>
            <span className="new-bot__value">
              {summary.all ? t("synbotEditor:allProjects") : null}
              {shown.map((project) => (
                <span key={project.id} className="new-bot__item">
                  <ProjectSidebarIcon
                    cwd={project.cwd}
                    expanded={false}
                    appearance={project.appearance}
                  />
                  <span className="new-bot__item-name">{project.name}</span>
                </span>
              ))}
              {more > 0 ? <span className="new-bot__more">+{more}</span> : null}
            </span>
            <ChevronDownIcon className="new-bot__chevron size-3.5" />
          </button>
        }
      />
      <Menu
        label={t("synbotEditor:engineSection")}
        items={engine.items}
        place="below-end"
        onOpenChange={engine.setOpen}
        trigger={
          <button type="button" className="new-bot__row">
            <span className="new-bot__label">{t("synbotEditor:engineSection")}</span>
            <span className="new-bot__value">
              <span className="new-bot__item">
                <ProviderIcon provider={form.modelSelection.provider} className="size-4" />
                <span className="new-bot__item-name">{engine.modelName}</span>
              </span>
            </span>
            <ChevronDownIcon className="new-bot__chevron size-3.5" />
          </button>
        }
      />
      <Menu
        label={t("synbotEditor:newWork")}
        items={autonomyItems}
        place="below-end"
        trigger={
          <button type="button" className="new-bot__row">
            <span className="new-bot__label">{t("synbotEditor:newWork")}</span>
            <span className="new-bot__value">
              <span className="new-bot__item">
                {autonomy?.glyph}
                <span className="new-bot__item-name">{autonomy?.label}</span>
              </span>
            </span>
            <ChevronDownIcon className="new-bot__chevron size-3.5" />
          </button>
        }
      />
      {instructions !== "closed" ? (
        <div className="new-bot__instructions">
          <textarea
            className="bot-sheet__instructions"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by "Add instructions"
            autoFocus={instructions === "added"}
            value={form.instructions}
            maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
            rows={4}
            placeholder={t("synbotEditor:instructionsPlaceholder")}
            aria-label={t("synbotEditor:instructions")}
            onChange={(event) => onChange({ instructions: event.target.value })}
          />
        </div>
      ) : (
        <button type="button" className="new-bot__add" onClick={onAddInstructions}>
          <PlusIcon className="size-3.5" />
          {t("synbotEditor:addInstructions")}
        </button>
      )}
    </div>
  );
}
