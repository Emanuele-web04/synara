// FILE: BotEditorSheet.tsx
// Purpose: The bot sheet (ported from HoloBot's BotSheet): create a bot from a template, the
//          coding crew or blank, or edit one. Create sends `bots.create` (a fresh request id per
//          submit, reused when the same submit is retried); edit sends only what changed with
//          `bots.update` and the revision the sheet opened; Remove asks first. SynBot keeps its
//          name, role, scope and shape. The `bots.*` stream updates the store afterwards.
// Layer: SynBot editor UI
// Exports: BotEditorHost

import type { Bot, ProjectId } from "@synara/contracts";
import { mascotForIndex } from "@synara/shared/bots";
import { useEffect, useRef, useState } from "react";

import { resolveSaveAttemptRequestId } from "~/components/chat/group/groupSettingsDialog.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";
import {
  SettingsCard,
  SettingsListRow,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { startSynbotLiveSync, useSynbotStore } from "~/synbot/synbotStore";

import { BotMascot } from "../BotMascot";
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
} from "./botEditor.logic";
import {
  BotBehaviorSection,
  BotEngineSection,
  BotIdentitySection,
  BotScopeSection,
} from "./BotEditorSections";
import { useBotEditor, type BotEditorTarget } from "./botEditorStore";
import { BotTemplatePicker, type BotTemplateChoice } from "./BotTemplatePicker";
import { useBotDefaultEngine } from "./useBotDefaultEngine";

type SaveError =
  | { readonly kind: "conflict" }
  | { readonly kind: "message"; readonly text: string };

interface BotEditorHostProps {
  /** After a create: the new bot, or the crew's bots in crew order. */
  readonly onCreated?: ((bots: readonly Bot[]) => void) | undefined;
  readonly onRemoved?: ((botId: ProjectId) => void) | undefined;
}

/** Mount once (the SynBot page); open it with `useBotEditor`. */
export function BotEditorHost(props: BotEditorHostProps) {
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

  return (
    <Dialog
      open={open && target !== null}
      onOpenChange={(next) => {
        // A close mid-save would drop the in-flight request's outcome.
        if (!next && !useBotEditor.getState().busy) close();
      }}
    >
      <DialogPopup className="max-w-2xl">
        {target ? (
          <BotEditorContent
            key={session}
            target={target}
            bot={bot}
            bots={bots}
            onClose={close}
            onCreated={props.onCreated}
            onRemoved={props.onRemoved}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function BotEditorContent(
  props: BotEditorHostProps & {
    readonly target: BotEditorTarget;
    readonly bot: Bot | null;
    readonly bots: readonly Bot[];
    readonly onClose: () => void;
  },
) {
  const { t } = useTranslation();
  if (props.target.mode === "edit" && props.bot === null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("synbotEditor:editTitle")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex min-h-40 items-center justify-center">
          <Spinner aria-label={t("synbotEditor:loading")} className="size-4" />
        </DialogPanel>
      </>
    );
  }
  return <BotEditorBody {...props} />;
}

function initialChoice(target: BotEditorTarget): BotTemplateChoice | null {
  if (target.mode !== "create" || target.template === null) return null;
  if (target.template.toLowerCase() === BOT_EDITOR_CREW_TEMPLATE) return BOT_EDITOR_CREW_TEMPLATE;
  return findBotTemplate(target.template)?.name ?? null;
}

function BotEditorBody(
  props: BotEditorHostProps & {
    readonly target: BotEditorTarget;
    readonly bot: Bot | null;
    readonly bots: readonly Bot[];
    readonly onClose: () => void;
  },
) {
  const { t, formatLocale } = useTranslation();
  const defaultEngine = useBotDefaultEngine();
  const creating = props.target.mode === "create";
  const main = props.bot?.kind === "main";
  const blankMascotIndex = props.bots.filter((entry) => entry.kind !== "main").length;

  const [opened] = useState<BotEditorForm>(() => {
    if (props.bot) return botEditorFormFromBot(props.bot);
    const blank = blankBotEditorForm({
      modelSelection: defaultEngine,
      mascotIndex: blankMascotIndex,
    });
    const template = findBotTemplate(props.target.mode === "create" ? props.target.template : null);
    return template ? applyBotTemplate(blank, template) : blank;
  });
  const [form, setForm] = useState(opened);
  const [openedWith, setOpenedWith] = useState(opened);
  /** The bot as the sheet opened it: the base of the update and its expected revision. */
  const [baseBot, setBaseBot] = useState(props.bot);
  const [choice, setChoice] = useState(() => initialChoice(props.target));
  /** A new bot follows the default engine until the user picks one. */
  const [enginePicked, setEnginePicked] = useState(!creating);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // The last failed create; a retry of the same payload reuses its request id so the server
  // finds the first attempt instead of creating a twin.
  const failedAttemptRef = useRef<{ requestId: string; fingerprint: string } | null>(null);

  const busy = saving || removing;
  useEffect(() => {
    useBotEditor.getState().setBusy(busy);
    return () => useBotEditor.getState().setBusy(false);
  }, [busy]);

  const effective: BotEditorForm = enginePicked ? form : { ...form, modelSelection: defaultEngine };
  const crewMode = creating && choice === BOT_EDITOR_CREW_TEMPLATE;
  const crew = missingCrewTemplates(props.bots);
  const update = (patch: Partial<BotEditorForm>) => {
    setError(null);
    setForm((current) => ({ ...current, ...patch }));
  };
  const pickEngine = (patch: Partial<BotEditorForm>) => {
    setEnginePicked(true);
    update({ ...(enginePicked ? {} : { modelSelection: defaultEngine }), ...patch });
  };

  const updateInput = !creating && baseBot ? botUpdateInput(baseBot, form) : null;
  const issue = crewMode ? null : botEditorIssue(effective);
  const canSave = crewMode ? crew.length > 0 : issue === null && (creating || updateInput !== null);

  const save = async () => {
    if (busy || !canSave) return;
    const api = readNativeApi();
    if (!api) {
      setError({ kind: "message", text: t("synbotEditor:unavailable") });
      return;
    }
    const fingerprint = crewMode
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
      if (crewMode) {
        const created: Bot[] = [];
        for (const input of crewCreateInputs({
          bots: props.bots,
          modelSelection: effective.modelSelection,
          requestId,
        })) {
          const bot = await api.bots.create(input);
          store.applyEvent({ type: "bot-upserted", bot });
          created.push(bot);
        }
        props.onCreated?.(created);
      } else if (creating) {
        const bot = await api.bots.create(botCreateInput(effective, requestId));
        store.applyEvent({ type: "bot-upserted", bot });
        props.onCreated?.([bot]);
      } else if (updateInput) {
        const bot = await api.bots.update(updateInput);
        store.applyEvent({ type: "bot-upserted", bot });
      }
      failedAttemptRef.current = null;
      setSaving(false);
      props.onClose();
    } catch (cause) {
      failedAttemptRef.current = { requestId, fingerprint };
      const text = errorMessageOf(cause);
      setError(isBotConflictError(text) ? { kind: "conflict" } : { kind: "message", text });
      setSaving(false);
    }
  };

  // "Reload and retry": rebase the user's edits onto the bot as it is now.
  const reload = () => {
    if (!props.bot) return;
    const latest = botEditorFormFromBot(props.bot);
    setForm((current) => rebaseBotEditorForm(current, openedWith, latest));
    setOpenedWith(latest);
    setBaseBot(props.bot);
    setError(null);
  };

  const remove = async () => {
    const bot = baseBot;
    const api = readNativeApi();
    if (!bot || !api || removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await api.bots.remove({ id: bot.id });
      useSynbotStore.getState().applyEvent({ type: "bot-removed", botId: bot.id });
      setRemoving(false);
      setConfirmRemove(false);
      props.onRemoved?.(bot.id);
      props.onClose();
    } catch (cause) {
      setRemoveError(errorMessageOf(cause));
      setRemoving(false);
    }
  };

  const title = crewMode
    ? t("synbotEditor:crewTitle")
    : creating
      ? t("synbotEditor:newTitle")
      : (baseBot?.name ?? t("synbotEditor:editTitle"));
  const description = crewMode
    ? t("synbotEditor:crewDescription", {
        names: new Intl.ListFormat(formatLocale).format(crew.map((template) => template.name)),
      })
    : creating
      ? t("synbotEditor:newDescription")
      : main
        ? t("synbotEditor:mainDescription")
        : t("synbotEditor:editDescription");
  const submitLabel = crewMode
    ? t("synbotEditor:createCrew", { count: crew.length })
    : creating
      ? t("synbotEditor:create")
      : t("computer:form_save");

  return (
    <>
      <DialogHeader className="border-b border-[color:var(--color-border-light)] pb-3">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="pt-3">
        {creating ? (
          <SettingsSectionShell title="synbotEditor:startFrom">
            <BotTemplatePicker
              templates={availableBotTemplates(props.bots)}
              crew={crew}
              selected={choice}
              blankMascot={mascotForIndex(blankMascotIndex)}
              onPickTemplate={(template) => {
                setChoice(template.name);
                update(applyBotTemplate(form, template));
              }}
              onPickCrew={() => {
                setChoice(BOT_EDITOR_CREW_TEMPLATE);
                setError(null);
              }}
              onPickBlank={() => {
                setChoice("blank");
                const blank = blankBotEditorForm({
                  modelSelection: defaultEngine,
                  mascotIndex: blankMascotIndex,
                });
                update({
                  name: blank.name,
                  role: blank.role,
                  mascot: blank.mascot,
                  instructions: blank.instructions,
                });
              }}
            />
          </SettingsSectionShell>
        ) : null}
        {crewMode ? (
          <>
            <SettingsSectionShell title="synbotEditor:crewSection">
              <SettingsCard>
                {crew.length === 0 ? (
                  <SettingsListRow title={t("synbotEditor:crewComplete")} />
                ) : (
                  crew.map((template) => (
                    <SettingsListRow
                      key={template.name}
                      leading={<BotMascot mascot={template.mascot} size="row" still />}
                      title={template.name}
                      description={template.role}
                    />
                  ))
                )}
              </SettingsCard>
            </SettingsSectionShell>
            <BotEngineSection
              modelSelection={effective.modelSelection}
              taskModelSelection={null}
              defaultSelection={defaultEngine}
              showTaskEngine={false}
              onModelChange={(modelSelection) => pickEngine({ modelSelection })}
              onTaskModelChange={() => undefined}
            />
          </>
        ) : (
          <>
            <BotIdentitySection form={effective} main={main} onChange={update} />
            <BotScopeSection form={effective} main={main} onChange={update} />
            <BotEngineSection
              modelSelection={effective.modelSelection}
              taskModelSelection={effective.taskModelSelection}
              defaultSelection={creating ? defaultEngine : null}
              showTaskEngine
              onModelChange={(modelSelection) => pickEngine({ modelSelection })}
              onTaskModelChange={(taskModelSelection) => update({ taskModelSelection })}
            />
            <BotBehaviorSection form={effective} main={main} onChange={update} />
          </>
        )}
      </DialogPanel>
      <DialogFooter className="border-t border-[color:var(--color-border-light)]">
        {!creating && !main ? (
          <Button
            type="button"
            variant="destructive-outline"
            className="sm:me-auto"
            disabled={busy}
            onClick={() => {
              setRemoveError(null);
              setConfirmRemove(true);
            }}
          >
            {t("synbotEditor:remove")}
          </Button>
        ) : null}
        {error ? (
          <div className="flex items-center gap-2 self-center sm:me-auto" role="alert">
            <p className="text-ui text-destructive">
              {error.kind === "conflict" ? t("synbotEditor:conflict") : error.text}
            </p>
            {error.kind === "conflict" && props.bot ? (
              <Button type="button" variant="outline" size="xs" onClick={reload}>
                {t("synbotEditor:reload")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>
          {t("common:form_cancel")}
        </Button>
        <Button type="button" disabled={busy || !canSave} onClick={() => void save()}>
          {saving ? <Spinner className="size-3.5" /> : null}
          {submitLabel}
        </Button>
      </DialogFooter>
      <AlertDialog
        open={confirmRemove}
        onOpenChange={(next) => {
          if (!next && !removing) setConfirmRemove(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("synbotEditor:removeTitle", { value0: baseBot?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("synbotEditor:removeMessage")}</AlertDialogDescription>
          </AlertDialogHeader>
          {removeError ? (
            <p className="px-5 text-ui-sm text-destructive" role="alert">
              {removeError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" disabled={removing} />}>
              {t("common:form_cancel")}
            </AlertDialogClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={removing}
              onClick={() => void remove()}
            >
              {t("synbotEditor:remove")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
