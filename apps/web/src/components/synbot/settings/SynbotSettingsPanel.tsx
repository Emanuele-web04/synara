// FILE: SynbotSettingsPanel.tsx
// Purpose: Settings → SynBot (Beta) in HoloBot's settings controls (settings/SettingsDialog.tsx,
//          controls.tsx): the bots (face, name and role, where it works and its engine; Edit
//          opens its sheet; New bot…), then how bots recap, whether they control chats without
//          asking, the merge proof and how many tasks run at once, each a row with its control
//          on the right. Values come from the live SynBot store; each change is one
//          `bots.updateSettings` call (the server owns the values).
// Layer: Settings UI panel
// Exports: SynbotSettingsPanel

import {
  BOT_PARALLEL_TASKS_MAX,
  BOT_PARALLEL_TASKS_MIN,
  type Bot,
  type BotRecapMode,
  type BotsUpdateSettingsInput,
} from "@synara/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { describeErrorMessage } from "@synara/shared/errorMessages";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { SETTINGS_TARGETS } from "~/settingsNavigation";
import { useStore } from "~/store";
import { orderedBots } from "~/synbot/synbotState.logic";
import { startSynbotLiveSync, useSynbotStore } from "~/synbot/synbotStore";

import { toastManager } from "../../ui/toast";
import { BotFace } from "../BotFace";
import { BotSheetHost } from "../editor/BotSheet";
import { useBotEditor } from "../editor/botEditorStore";
import { CapsuleButton, Field, Segmented, Switch, Text } from "../kit/controls";
import { engineLabel } from "../thread/useEngineMenu";
import "../kit/holobot.css";
import "./settings.css";

/** A setting on one line: its name (and a hint under it) left, the control right. */
function Row({
  id,
  label,
  hint,
  children,
}: {
  readonly id?: string;
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div id={id} className="settings-row">
      <div className="settings-row__text">
        <Text variant="small">{label}</Text>
        {hint ? (
          <Text variant="caption" tone="muted">
            {hint}
          </Text>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** A count from min to max in a compact native select. */
function Count({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  return (
    <span className="settings-select">
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {Array.from(
          { length: BOT_PARALLEL_TASKS_MAX - BOT_PARALLEL_TASKS_MIN + 1 },
          (_, index) => index + BOT_PARALLEL_TASKS_MIN,
        ).map((count) => (
          <option key={count} value={count}>
            {count}
          </option>
        ))}
      </select>
    </span>
  );
}

function BotsSection() {
  const { t } = useTranslation();
  const bots = useSynbotStore((store) => store.data.bots);
  const projects = useStore((store) => store.projects);
  const openEdit = useBotEditor((store) => store.openEdit);
  const openCreate = useBotEditor((store) => store.openCreate);
  const { main, pinned, others } = orderedBots(bots);
  const ordered = [...(main ? [main] : []), ...pinned, ...others];
  const where = (bot: Bot) =>
    bot.scope.projects === "all"
      ? t("synbotEditor:allProjects")
      : bot.scope.projects
          .map(
            (id) =>
              projects.find((project) => project.id === id)?.name ??
              t("synbotEditor:removedProject"),
          )
          .join(", ");
  return (
    <Field
      className="settings__section"
      title={t("synbotEditor:settingsBotsSection")}
      hint={t("synbotEditor:settingsBotsHint")}
    >
      <ul className="settings-rows">
        {ordered.map((bot) => (
          <li key={bot.id} className="settings-row settings-bot">
            <BotFace bot={bot} size="card" />
            <span className="settings-row__text">
              <Text variant="small" as="span">
                {bot.role ? `${bot.name} · ${bot.role}` : bot.name}
              </Text>
              <Text variant="caption" tone="muted" as="span" truncate>
                {`${where(bot)} · ${engineLabel(bot.modelSelection)}`}
              </Text>
            </span>
            <CapsuleButton kind="ghost" small onClick={() => openEdit(bot.id)}>
              {t("synbotEditor:edit")}
            </CapsuleButton>
          </li>
        ))}
      </ul>
      <div className="settings__action">
        <CapsuleButton kind="normal" compact onClick={() => openCreate()}>
          {t("synbotEditor:newBotEllipsis")}
        </CapsuleButton>
      </div>
    </Field>
  );
}

export function SynbotSettingsPanel() {
  const { t } = useTranslation();
  const status = useSynbotStore((store) => store.status);
  const settings = useSynbotStore((store) => store.data.settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (useSynbotStore.getState().status === "idle") startSynbotLiveSync();
  }, []);

  if (status === "unavailable" || status === "error") {
    return (
      <div className="hb synbot-settings">
        <Text variant="small" tone={status === "error" ? "bad" : "muted"}>
          {status === "error"
            ? t("synbotEditor:settingsLoadFailed")
            : t("synbotEditor:unavailable")}
        </Text>
      </div>
    );
  }
  if (status !== "ready") {
    return (
      <div className="hb synbot-settings">
        <Text variant="small" tone="muted">
          {t("synbotEditor:loading")}
        </Text>
      </div>
    );
  }

  const save = async (patch: BotsUpdateSettingsInput) => {
    const api = readNativeApi();
    if (!api || saving) return;
    setSaving(true);
    try {
      const next = await api.bots.updateSettings(patch);
      useSynbotStore.getState().applyEvent({ type: "settings-updated", settings: next });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("synbotEditor:settingsSaveFailed"),
        description: describeErrorMessage(error, String(error)),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="hb synbot-settings">
      <BotsSection />
      <Field
        className="settings__section"
        title={t("synbotEditor:recap")}
        hint={t("synbotEditor:recapDescription")}
      >
        <div id={SETTINGS_TARGETS.synbotRecap}>
          <Segmented<BotRecapMode>
            label={t("synbotEditor:recap")}
            value={settings.recapMode}
            disabled={saving}
            options={[
              { value: "request", label: t("synbotEditor:recapRequest") },
              { value: "task", label: t("synbotEditor:recapTask") },
            ]}
            onChange={(recapMode) => void save({ recapMode })}
          />
        </div>
      </Field>
      <Field
        className="settings__section"
        title={t("synbotEditor:workSection")}
        hint={t("synbotEditor:workSectionHint")}
      >
        <div className="settings-rows">
          <Row
            id={SETTINGS_TARGETS.synbotControlChats}
            label={t("synbotEditor:controlChats")}
            hint={t("synbotEditor:controlChatsDescription")}
          >
            <Switch
              checked={settings.controlWithoutAsking}
              disabled={saving}
              ariaLabel={t("synbotEditor:controlChats")}
              onChange={(checked) => void save({ controlWithoutAsking: checked })}
            />
          </Row>
          <Row
            id={SETTINGS_TARGETS.synbotMergeProof}
            label={t("synbotEditor:mergeProof")}
            hint={t("synbotEditor:mergeProofDescription")}
          >
            <Switch
              checked={settings.mergeProofEnabled}
              disabled={saving}
              ariaLabel={t("synbotEditor:mergeProof")}
              onChange={(checked) => void save({ mergeProofEnabled: checked })}
            />
          </Row>
          <Row
            id={SETTINGS_TARGETS.synbotParallelTasks}
            label={t("synbotEditor:parallelTasks")}
            hint={t("synbotEditor:parallelTasksDescription")}
          >
            <Count
              label={t("synbotEditor:parallelTasks")}
              value={settings.maxParallelTasks}
              disabled={saving}
              onChange={(maxParallelTasks) => void save({ maxParallelTasks })}
            />
          </Row>
        </div>
      </Field>
      <BotSheetHost />
    </div>
  );
}
