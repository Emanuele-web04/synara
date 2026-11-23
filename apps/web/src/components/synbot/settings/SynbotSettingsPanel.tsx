// FILE: SynbotSettingsPanel.tsx
// Purpose: Settings → SynBot (Beta) on Synara's own settings primitives (SettingsSection,
//          SettingsRow, SettingsListRow, ui/switch, the settings select and segmented control):
//          the bots (face, name and role, where each works and its engine; Edit opens its sheet;
//          New bot…), then how bots work: how they recap, whether they control chats without
//          asking, the merge proof and how many tasks run at once. Values come from the live
//          SynBot store; each change is one `bots.updateSettings` call (the server owns the
//          values), and only the control being saved waits for it. Without Alto it shows the
//          SynBot page's gate.
// Layer: Settings UI panel
// Exports: SynbotSettingsPanel

import {
  BOT_PARALLEL_TASKS_MAX,
  BOT_PARALLEL_TASKS_MIN,
  type Bot,
  type BotRecapMode,
  type BotsUpdateSettingsInput,
} from "@synara/contracts";
import { describeErrorMessage } from "@synara/shared/errorMessages";
import { useEffect, useState } from "react";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { SETTINGS_TARGETS } from "~/settingsNavigation";
import { useStore } from "~/store";
import { orderedBots } from "~/synbot/synbotState.logic";
import {
  ensureSynbotMain,
  restartSynbotLiveSync,
  startSynbotLiveSync,
  useSynbotStore,
} from "~/synbot/synbotStore";

import { SettingsSegmentedControl, SettingsSelectControl } from "../../settings/SettingControls";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "../../settings/SettingsPanelPrimitives";
import { Button } from "../../ui/button";
import { SelectItem } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { BotFace, botMood } from "../BotFace";
import { BotSheetHost } from "../editor/BotSheet";
import { useBotEditor } from "../editor/botEditorStore";
import { SynbotAltoGate } from "../shell/SynbotAltoGate";
import { engineLabel } from "../thread/useEngineMenu";

type SettingKey = keyof BotsUpdateSettingsInput;

const PARALLEL_TASK_COUNTS = Array.from(
  { length: BOT_PARALLEL_TASKS_MAX - BOT_PARALLEL_TASKS_MIN + 1 },
  (_, index) => String(index + BOT_PARALLEL_TASKS_MIN),
);

const RECAP_OPTIONS = [
  { value: "request", label: "synbotEditor:recapRequest" },
  { value: "task", label: "synbotEditor:recapTask" },
] as const satisfies readonly { value: BotRecapMode; label: string }[];

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
    <SettingsSectionShell
      title="synbotEditor:settingsBotsSection"
      action={
        <Button size="xs" variant="ghost" onClick={() => openCreate()}>
          {t("synbotEditor:newBotEllipsis")}
        </Button>
      }
    >
      <SettingsCard>
        {ordered.map((bot) => (
          <SettingsListRow
            key={bot.id}
            leading={<BotFace bot={bot} size="row" mood={botMood(bot.status)} />}
            title={bot.role ? `${bot.name} · ${bot.role}` : bot.name}
            description={
              <span className="block truncate">{`${where(bot)} · ${engineLabel(bot.modelSelection)}`}</span>
            }
            actions={
              <Button
                size="sm"
                variant="outline"
                aria-label={t("synbot:editBot", { name: bot.name })}
                onClick={() => openEdit(bot.id)}
              >
                {t("synbotEditor:edit")}
              </Button>
            }
          />
        ))}
      </SettingsCard>
      <p className="px-2 text-ui-sm text-muted-foreground">{t("synbotEditor:settingsBotsHint")}</p>
    </SettingsSectionShell>
  );
}

/** Reloads SynBot after a failed load. */
function retryLoad() {
  restartSynbotLiveSync();
  void ensureSynbotMain();
}

export function SynbotSettingsPanel() {
  const { t } = useTranslation();
  const status = useSynbotStore((store) => store.status);
  const settings = useSynbotStore((store) => store.data.settings);
  // The settings being saved: each control waits for its own answer, the rest stay usable.
  const [pending, setPending] = useState<ReadonlySet<SettingKey>>(() => new Set());

  useEffect(() => {
    const current = useSynbotStore.getState().status;
    if (current === "subscription_required") restartSynbotLiveSync();
    else if (current === "idle") startSynbotLiveSync();
  }, []);

  if (status === "subscription_required") {
    return (
      <SettingsCard>
        <div className="px-4 py-8">
          <SynbotAltoGate />
        </div>
      </SettingsCard>
    );
  }
  if (status === "unavailable") {
    return <SettingsEmptyState>{t("synbotEditor:unavailable")}</SettingsEmptyState>;
  }
  if (status === "error") {
    return (
      <SettingsEmptyState tone="destructive">
        <div className="flex flex-col items-center gap-3">
          <span>{t("synbotEditor:settingsLoadFailed")}</span>
          <Button size="sm" variant="outline" onClick={retryLoad}>
            {t("common:common_retry")}
          </Button>
        </div>
      </SettingsEmptyState>
    );
  }
  if (status !== "ready") {
    return <SettingsEmptyState layout="status">{t("synbotEditor:loading")}</SettingsEmptyState>;
  }

  const save = async (patch: BotsUpdateSettingsInput) => {
    const api = readNativeApi();
    const keys = Object.keys(patch) as SettingKey[];
    if (!api || keys.some((key) => pending.has(key))) return;
    setPending((current) => new Set([...current, ...keys]));
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
      setPending((current) => new Set([...current].filter((key) => !keys.includes(key))));
    }
  };

  return (
    <div>
      <BotsSection />
      <SettingsSection title="synbotEditor:workSection">
        <SettingsRow
          id={SETTINGS_TARGETS.synbotRecap}
          title="synbotEditor:recap"
          description="synbotEditor:recapDescription"
          control={
            <SettingsSegmentedControl<BotRecapMode>
              value={settings.recapMode}
              options={RECAP_OPTIONS}
              ariaLabel={t("synbotEditor:recap")}
              disabled={pending.has("recapMode")}
              onValueChange={(recapMode) => {
                if (recapMode !== settings.recapMode) void save({ recapMode });
              }}
            />
          }
        />
        <SettingsRow
          id={SETTINGS_TARGETS.synbotControlChats}
          title="synbotEditor:controlChats"
          description="synbotEditor:controlChatsDescription"
          control={
            <Switch
              checked={settings.controlWithoutAsking}
              disabled={pending.has("controlWithoutAsking")}
              aria-label={t("synbotEditor:controlChats")}
              onCheckedChange={(checked) => void save({ controlWithoutAsking: checked })}
            />
          }
        />
        <SettingsRow
          id={SETTINGS_TARGETS.synbotMergeProof}
          title="synbotEditor:mergeProof"
          description="synbotEditor:mergeProofDescription"
          control={
            <Switch
              checked={settings.mergeProofEnabled}
              disabled={pending.has("mergeProofEnabled")}
              aria-label={t("synbotEditor:mergeProof")}
              onCheckedChange={(checked) => void save({ mergeProofEnabled: checked })}
            />
          }
        />
        <SettingsRow
          id={SETTINGS_TARGETS.synbotParallelTasks}
          title="synbotEditor:parallelTasks"
          description="synbotEditor:parallelTasksDescription"
          control={
            <SettingsSelectControl
              value={String(settings.maxParallelTasks)}
              disabled={pending.has("maxParallelTasks")}
              ariaLabel={t("synbotEditor:parallelTasks")}
              triggerClassName="w-full sm:w-24"
              valueContent={String(settings.maxParallelTasks)}
              onValueChange={(value) => void save({ maxParallelTasks: Number(value) })}
            >
              {PARALLEL_TASK_COUNTS.map((count) => (
                <SelectItem key={count} hideIndicator value={count}>
                  {count}
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />
      </SettingsSection>
      <BotSheetHost />
    </div>
  );
}
