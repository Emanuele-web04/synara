// FILE: ProvidersSettings.tsx
// Purpose: Providers settings panel (update prompts, picker visibility/order, per-CLI install overrides).
// Layer: Settings UI components
// Exports: ProvidersSettings, provider version-label helpers consumed by the settings route
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderStatus,
} from "@t3tools/contracts";
import { type Dispatch, type RefObject, type SetStateAction, useMemo } from "react";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { type AppSettings } from "../../appSettings";
import { CentralIcon } from "../../lib/central-icons";
import { DownloadIcon, Loader2Icon } from "../../lib/icons";
import { SETTINGS_INSET_LIST_CLASS_NAME } from "../../settingsPanelStyles";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingResetButton } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import {
  ProviderInstallsSection,
  formatProviderVersion,
  providerUpdateFailureMessage,
  providerUpdateStatusLabel,
} from "./ProviderInstallsSettings";

export { formatProviderVersion, providerUpdateFailureMessage, providerUpdateStatusLabel };

const PROVIDER_VISIBILITY_OPTIONS: ReadonlyArray<{
  provider: ProviderKind;
  title: string;
}> = [
  { provider: "codex", title: PROVIDER_DISPLAY_NAMES.codex },
  { provider: "claudeAgent", title: PROVIDER_DISPLAY_NAMES.claudeAgent },
  { provider: "cursor", title: PROVIDER_DISPLAY_NAMES.cursor },
  { provider: "gemini", title: PROVIDER_DISPLAY_NAMES.gemini },
  { provider: "grok", title: PROVIDER_DISPLAY_NAMES.grok },
  { provider: "kilo", title: PROVIDER_DISPLAY_NAMES.kilo },
  { provider: "opencode", title: PROVIDER_DISPLAY_NAMES.opencode },
  { provider: "pi", title: PROVIDER_DISPLAY_NAMES.pi },
];

// Pure helper kept at module scope so the toggle handler stays trivial and the
// dedupe logic is shared between the toggle and the schema normalizer.
export function setProviderHidden(
  current: ReadonlyArray<ProviderKind>,
  provider: ProviderKind,
  hidden: boolean,
): ProviderKind[] {
  const withoutTarget = current.filter((entry) => entry !== provider);
  return hidden ? [...withoutTarget, provider] : withoutTarget;
}

function SortableProviderVisibilityRow(props: {
  option: { provider: ProviderKind; title: string };
  isHidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.option.provider });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border border-[color:var(--color-border)] bg-transparent px-3 py-2.5",
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-foreground active:cursor-grabbing"
          aria-label={`Reorder ${props.option.title}`}
          {...attributes}
          {...listeners}
        >
          <CentralIcon name="dot-grid-2x3" className="size-4" />
        </button>
        <span className="min-w-0 text-sm text-foreground">{props.option.title}</span>
      </div>
      <Switch
        checked={!props.isHidden}
        onCheckedChange={(checked) => props.onHiddenChange(!checked)}
        aria-label={`Show ${props.option.title} in the provider picker`}
      />
    </div>
  );
}

function ProviderUpdatesSection(props: {
  providerUpdatesRef: RefObject<HTMLDivElement | null>;
  outdatedProviderCount: number;
  outdatedProviderStatuses: ReadonlyArray<ServerProviderStatus>;
  updatingProviders: ReadonlySet<ProviderKind>;
  onRunProviderUpdate: (provider: ProviderKind) => void;
}) {
  const {
    providerUpdatesRef,
    outdatedProviderCount,
    outdatedProviderStatuses,
    updatingProviders,
    onRunProviderUpdate,
  } = props;
  return (
    <div ref={providerUpdatesRef} id="provider-updates">
      <SettingsSection title="Updates">
        <SettingsRow
          title="Provider updates"
          description="Update installed provider tools that Synara can safely update."
          status={
            outdatedProviderCount > 0
              ? `${outdatedProviderCount} update${outdatedProviderCount === 1 ? "" : "s"} available`
              : "No provider updates detected"
          }
        >
          {outdatedProviderStatuses.length > 0 ? (
            <div className={cn("mt-4", SETTINGS_INSET_LIST_CLASS_NAME)}>
              {outdatedProviderStatuses.map((providerStatus) => {
                const updateAdvisory = providerStatus.versionAdvisory;
                const updateState = providerStatus.updateState?.status;
                const isProviderUpdateActive =
                  updateState === "queued" ||
                  updateState === "running" ||
                  updatingProviders.has(providerStatus.provider);
                const canUpdateProvider =
                  updateAdvisory?.canUpdate === true && !isProviderUpdateActive;
                const updateLabel = providerUpdateStatusLabel(providerStatus);

                return (
                  <div
                    key={providerStatus.provider}
                    className="flex min-h-11 items-center gap-3 border-t border-[color:var(--color-border)] px-3 py-2 first:border-t-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {PROVIDER_DISPLAY_NAMES[providerStatus.provider]}
                      </div>
                      {updateLabel ? (
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {updateLabel}
                        </div>
                      ) : null}
                    </div>
                    {updateAdvisory?.canUpdate ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={!canUpdateProvider}
                        title={
                          updateAdvisory.updateCommand
                            ? `Run ${updateAdvisory.updateCommand}`
                            : undefined
                        }
                        onClick={() => onRunProviderUpdate(providerStatus.provider)}
                      >
                        {isProviderUpdateActive ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <DownloadIcon className="size-3.5" />
                        )}
                        {isProviderUpdateActive ? "Updating" : "Update"}
                      </Button>
                    ) : (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        Manual update
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

export function ProvidersSettings(props: {
  settings: AppSettings;
  defaults: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  providerUpdatesRef: RefObject<HTMLDivElement | null>;
  providerInstallsRef: RefObject<HTMLDivElement | null>;
  outdatedProviderCount: number;
  outdatedProviderStatuses: ReadonlyArray<ServerProviderStatus>;
  providerStatusByProvider: ReadonlyMap<ProviderKind, ServerProviderStatus>;
  updatingProviders: ReadonlySet<ProviderKind>;
  onRunProviderUpdate: (provider: ProviderKind) => void;
  hiddenProviderSet: ReadonlySet<ProviderKind>;
  hiddenProviderCount: number;
  isProviderOrderDirty: boolean;
  onProviderOrderDragEnd: (event: DragEndEvent) => void;
  isInstallSettingsDirty: boolean;
  openInstallProviders: Record<ProviderKind, boolean>;
  setOpenInstallProviders: Dispatch<SetStateAction<Record<ProviderKind, boolean>>>;
}) {
  const {
    settings,
    defaults,
    updateSettings,
    providerUpdatesRef,
    providerInstallsRef,
    outdatedProviderCount,
    outdatedProviderStatuses,
    providerStatusByProvider,
    updatingProviders,
    onRunProviderUpdate,
    hiddenProviderSet,
    hiddenProviderCount,
    isProviderOrderDirty,
    onProviderOrderDragEnd,
    isInstallSettingsDirty,
    openInstallProviders,
    setOpenInstallProviders,
  } = props;

  const providerVisibilitySensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 4,
      },
    }),
  );
  const providerVisibilityOptionsByProvider = useMemo(
    () => new Map(PROVIDER_VISIBILITY_OPTIONS.map((option) => [option.provider, option])),
    [],
  );
  const orderedProviderVisibilityOptions = useMemo(
    () =>
      settings.providerOrder.flatMap((provider) => {
        const option = providerVisibilityOptionsByProvider.get(provider);
        return option ? [option] : [];
      }),
    [providerVisibilityOptionsByProvider, settings.providerOrder],
  );

  return (
    <div className="space-y-6">
      <ProviderUpdatesSection
        providerUpdatesRef={providerUpdatesRef}
        outdatedProviderCount={outdatedProviderCount}
        outdatedProviderStatuses={outdatedProviderStatuses}
        updatingProviders={updatingProviders}
        onRunProviderUpdate={onRunProviderUpdate}
      />
      <SettingsSection title="Provider picker">
        <SettingsRow
          title="Visible providers"
          description="Drag providers into your preferred picker order and hide the ones you don't use. The provider you're currently using on a thread always stays visible."
          status={
            hiddenProviderCount > 0
              ? `${hiddenProviderCount} provider${hiddenProviderCount === 1 ? "" : "s"} hidden`
              : isProviderOrderDirty
                ? "Custom order"
                : "All providers visible"
          }
          resetAction={
            hiddenProviderCount > 0 || isProviderOrderDirty ? (
              <SettingResetButton
                label="provider picker"
                onClick={() =>
                  updateSettings({
                    hiddenProviders: defaults.hiddenProviders,
                    providerOrder: defaults.providerOrder,
                  })
                }
              />
            ) : null
          }
        >
          <DndContext
            sensors={providerVisibilitySensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onProviderOrderDragEnd}
          >
            <SortableContext
              items={orderedProviderVisibilityOptions.map((option) => option.provider)}
              strategy={verticalListSortingStrategy}
            >
              <div className="mt-4 space-y-2">
                {orderedProviderVisibilityOptions.map((option) => (
                  <SortableProviderVisibilityRow
                    key={option.provider}
                    option={option}
                    isHidden={hiddenProviderSet.has(option.provider)}
                    onHiddenChange={(hidden) =>
                      updateSettings({
                        hiddenProviders: setProviderHidden(
                          settings.hiddenProviders,
                          option.provider,
                          hidden,
                        ),
                      })
                    }
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </SettingsRow>
      </SettingsSection>
      <ProviderInstallsSection
        providerInstallsRef={providerInstallsRef}
        settings={settings}
        defaults={defaults}
        updateSettings={updateSettings}
        outdatedProviderCount={outdatedProviderCount}
        isInstallSettingsDirty={isInstallSettingsDirty}
        openInstallProviders={openInstallProviders}
        setOpenInstallProviders={setOpenInstallProviders}
        providerStatusByProvider={providerStatusByProvider}
        updatingProviders={updatingProviders}
        onRunProviderUpdate={onRunProviderUpdate}
      />
    </div>
  );
}
