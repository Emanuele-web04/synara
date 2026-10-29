import { Translation } from "~/i18n/Translation";
// FILE: ProvidersSettingsPanel.tsx
// Purpose: Own provider picker, update, and CLI installation settings workflows.
// Layer: Settings panel

import {
  DEFAULT_CODEX_ACCOUNT_ID,
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerSettings,
} from "@synara/contracts";
import { isBetaFeatureOn, VISIBLE_PROVIDER_DESCRIPTORS } from "../../betaFeatures";
import {
  normalizeProviderCliAlias,
  providerCliCommandName,
} from "@synara/shared/providerCliProfiles";
import { providerImportedDirectoryConfig } from "@synara/shared/providerInstances";
import { pluralize } from "~/i18n/pluralize";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  buildProviderInstanceSettingsPatch,
  getCodexAccountOptions,
  getManageableProviderInstances,
  getProviderInstanceOptions,
  removeManageableProviderInstance,
  type AppSettings,
  type AppSettingsBinding,
  type ManageableProviderInstance,
  type ProviderInstanceOption,
  type ProviderInstancePatch,
} from "~/appSettings";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { CentralIcon } from "~/lib/central-icons";
import {
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  Loader2Icon,
  PlusIcon,
  PlayIcon,
  XIcon,
} from "~/lib/icons";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { normalizeProviderAccentColor } from "~/lib/providerInstancePresentation";
import {
  type ProviderAccountStatusSummary,
  type ProviderAccountStatusTone,
  providerAccountStatusSummary,
  providerSetupStatusLabel,
} from "~/lib/providerSetupStatus";
import {
  hasReconciledServerProviderStatuses,
  serverAllProviderUsageQueryOptions,
  serverConfigQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { isProviderKind, sameProviderOrder } from "~/providerOrdering";
import {
  getVisibleProviderUpdateStatuses,
  isProviderLatestVersionKnowable,
  isProviderUpdateActive,
  shouldOfferProviderUpdateAction,
  shouldPromptProviderUpdate,
  shouldShowProviderUpdateStatus,
  withProviderUpdateTimeout,
} from "~/providerUpdates";
import { providerStatusInstanceKey } from "~/lib/providerAvailability";
import { SETTINGS_TARGETS } from "~/settingsNavigation";
import {
  SETTINGS_INSET_LIST_CLASS_NAME,
  SETTINGS_INSET_RADIUS_CLASS_NAME,
  SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";
import { ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME } from "~/surfaceStyles";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ProviderIcon } from "../ProviderIcon";
import { ProviderAccountAvatar } from "../ProviderAccountMark";
import { StatusChip } from "../ui/status-chip";
import {
  AddProviderAccountDialog,
  type AddProviderAccountConfigField,
  type AddProviderAccountInput,
} from "./AddProviderAccountDialog";
import { DebouncedSettingTextInput } from "./DebouncedSettingTextInput";
import { ProviderAccentColorControl } from "./ProviderAccentColorControl";
import { ProviderInstanceEnvironmentEditor } from "./ProviderInstanceEnvironmentEditor";
import {
  SettingResetButton,
  SettingsSelectControl,
  useSettingsRestoreSignal,
} from "./SettingControls";
import { SettingsListRow, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { t, useTranslation } from "~/i18n";

type ProviderInstallTextKey =
  | "claudeBinaryPath"
  | "claudeHomePath"
  | "codexBinaryPath"
  | "codexHomePath"
  | "codexLaunchArgs"
  | "cursorBinaryPath"
  | "cursorApiEndpoint"
  | "devinBinaryPath"
  | "antigravityBinaryPath"
  | "grokBinaryPath"
  | "droidBinaryPath"
  | "openCodeBinaryPath"
  | "openCodeServerUrl"
  | "piBinaryPath"
  | "piAgentDir"
  | "ompBinaryPath"
  | "ompAgentDir";
type ProviderInstallPasswordKey = "openCodeServerPassword";
type ProviderInstallPasswordConfiguredKey = "openCodeServerPasswordConfigured";
type ProviderInstallBooleanKey =
  | "claudeEnableArtifacts"
  | "claudeConfirmColdCacheResume"
  | "openCodeExperimentalWebSockets";

type ProviderInstallTextField = {
  readonly kind: "text";
  readonly settingsKey: ProviderInstallTextKey;
  readonly label: string;
  readonly placeholder: string;
  readonly description: string | ((translate: typeof t) => ReactNode);
};
type ProviderInstallPasswordField = {
  readonly kind: "password";
  readonly settingsKey: ProviderInstallPasswordKey;
  readonly configuredKey: ProviderInstallPasswordConfiguredKey;
  readonly label: string;
  readonly placeholder: string;
  readonly description: string | ((translate: typeof t) => ReactNode);
};
type ProviderInstallBooleanField = {
  readonly kind: "boolean";
  readonly settingsKey: ProviderInstallBooleanKey;
  readonly label: string;
  readonly description: string | ((translate: typeof t) => ReactNode);
};
type ProviderInstallField =
  | ProviderInstallTextField
  | ProviderInstallPasswordField
  | ProviderInstallBooleanField;
type ProviderInstallSettings = {
  readonly provider: ProviderKind;
  readonly docs: ReadonlyArray<{ readonly label: string; readonly href: string }>;
  readonly fields: readonly ProviderInstallField[];
};

const PROVIDER_VISIBILITY_OPTIONS = VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => ({
  provider: descriptor.kind,
  title: descriptor.displayName,
  setupDocsHref: descriptor.setupDocsHref,
}));

const PROVIDER_INSTALL_SETTINGS: readonly ProviderInstallSettings[] = [
  {
    provider: "codex",
    docs: [
      {
        label: "settings:providers_docInstall",
        href: "https://help.openai.com/en/articles/11096431",
      },
      {
        label: "computer:providerUpdates_update",
        href: "https://help.openai.com/en/articles/11096431",
      },
      {
        label: "settings:providers_docConfig",
        href: "https://github.com/openai/codex/blob/main/docs/config.md",
      },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "codexBinaryPath",
        label: "settings:codexBinaryPath",
        placeholder: "settings:codexBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "codex" }}
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "codexHomePath",
        label: "settings:providers_codexHomePath",
        placeholder: "settings:cODEXHOME",
        description: "settings:providers_codexHomeDescription",
      },
      {
        kind: "text",
        settingsKey: "codexLaunchArgs",
        label: "Codex launch args",
        placeholder: '-c model_provider="apitoken"',
        description: (
          <>
            Extra CLI flags used for sessions on every Codex account, inserted before{" "}
            <code>app-server</code>. Tokens after an unquoted <code>--</code> are appended after{" "}
            <code>app-server</code>. Example: <code>-c model_provider=&quot;apitoken&quot;</code>.
          </>
        ),
      },
    ],
  },
  {
    provider: "claudeAgent",
    docs: [
      {
        label: "settings:providers_docInstall",
        href: "https://code.claude.com/docs/en/installation",
      },
      {
        label: "computer:providerUpdates_update",
        href: "https://code.claude.com/docs/en/installation#update-claude-code",
      },
      { label: "settings:providers_docConfig", href: "https://code.claude.com/docs/en/settings" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "claudeBinaryPath",
        label: "settings:claudeBinaryPath",
        placeholder: "settings:claudeBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "claude" }}
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "claudeHomePath",
        label: "settings:claudeHOMEPath",
        placeholder: "settings:claudeHOME",
        description: "settings:optionalHOMEDirectoryForThisClaudeAccount",
      },
      {
        kind: "boolean",
        settingsKey: "claudeEnableArtifacts",
        label: "settings:artifactsDesignAndSlides",
        description: () => (
          <Translation
            message="settings:claudeArtifactsDescription"
            components={{ design: <code />, slides: <code /> }}
          />
        ),
      },
      {
        kind: "boolean",
        settingsKey: "claudeConfirmColdCacheResume",
        label: "settings:askBeforeResumingALongIdleSession",
        description: "settings:offByDefaultLikeClaudeCodeWhenOnAfter",
      },
    ],
  },
  {
    provider: "cursor",
    docs: [
      {
        label: "settings:providers_docInstall",
        href: "https://docs.cursor.com/en/cli/installation",
      },
      {
        label: "computer:providerUpdates_update",
        href: "https://docs.cursor.com/en/cli/installation#updates",
      },
      { label: "settings:providers_docConfig", href: "https://docs.cursor.com/en/cli/overview" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "cursorBinaryPath",
        label: "settings:cursorBinaryPath",
        placeholder: "settings:cursorAgentOrCursorCLIPath",
        description: () => (
          <Translation
            message="settings:cursorBinaryDescription"
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "cursorApiEndpoint",
        label: "settings:providers_cursorApiEndpoint",
        placeholder: "https://api2.cursor.sh",
        description: "settings:optionalCursorAPIEndpointOverridePassedToCursorAgent",
      },
    ],
  },
  {
    provider: "antigravity",
    docs: [
      { label: "settings:providers_docInstall", href: "https://antigravity.google/docs/cli-using" },
      { label: "settings:reference", href: "https://antigravity.google/docs/cli-reference" },
      { label: "settings:hooks", href: "https://antigravity.google/docs/hooks" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "antigravityBinaryPath",
        label: "settings:antigravityBinaryPath",
        placeholder: "settings:antigravityCLIBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "agy" }}
            components={{ command: <code /> }}
          />
        ),
      },
    ],
  },
  {
    provider: "grok",
    docs: [
      { label: "settings:providers_docInstall", href: "https://docs.x.ai/build/overview" },
      {
        label: "settings:providers_docHeadless",
        href: "https://docs.x.ai/build/cli/headless-scripting",
      },
      { label: "settings:providers_docConfig", href: "https://docs.x.ai/build/overview" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "grokBinaryPath",
        label: "settings:grokBinaryPath",
        placeholder: "settings:grokBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "grok" }}
            components={{ command: <code /> }}
          />
        ),
      },
    ],
  },
  {
    provider: "droid",
    docs: [
      {
        label: "settings:quickstart",
        href: "https://docs.factory.ai/cli/getting-started/quickstart.md",
      },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "droidBinaryPath",
        label: "settings:droidBinaryPath",
        placeholder: "settings:droid",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "droid" }}
            components={{ command: <code /> }}
          />
        ),
      },
    ],
  },
  {
    provider: "devin",
    docs: [
      { label: "settings:providers_docInstall", href: "https://docs.devin.ai/cli" },
      { label: "settings:commands", href: "https://docs.devin.ai/cli/reference/commands" },
      {
        label: "settings:providers_docConfig",
        href: "https://docs.devin.ai/cli/reference/configuration/config-file",
      },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "devinBinaryPath",
        label: "settings:devinBinaryPath",
        placeholder: "settings:devin",
        description: () => (
          <Translation
            message="settings:devinBinaryDescription"
            components={{ command: <code />, login: <code /> }}
          />
        ),
      },
    ],
  },
  {
    provider: "opencode",
    docs: [
      { label: "settings:providers_docInstall", href: "https://opencode.ai/docs/" },
      { label: "computer:providerUpdates_update", href: "https://opencode.ai/docs/cli/" },
      { label: "settings:providers_docConfig", href: "https://opencode.ai/docs/config/" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "openCodeBinaryPath",
        label: "settings:openCodeBinaryPath",
        placeholder: "settings:openCodeBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "opencode" }}
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "openCodeServerUrl",
        label: "settings:openCodeServerURL",
        placeholder: "http://127.0.0.1:4096",
        description: "settings:optionalExistingOpenCodeServerURLLeaveBlankToSpawn",
      },
      {
        kind: "password",
        settingsKey: "openCodeServerPassword",
        configuredKey: "openCodeServerPasswordConfigured",
        label: "settings:openCodeServerPassword",
        placeholder: "settings:openCodeServerPassword",
        description: "settings:optionalPasswordForAnExternallyManagedOpenCodeServer",
      },
      {
        kind: "boolean",
        settingsKey: "openCodeExperimentalWebSockets",
        label: "settings:providers_openaiResponseWebSockets",
        description: "settings:providers_openaiResponseWebSocketsDescription",
      },
    ],
  },
  {
    provider: "pi",
    docs: [
      { label: "settings:providers_docInstall", href: "https://pi.dev/docs/latest" },
      { label: "computer:providerUpdates_update", href: "https://pi.dev/docs/latest/settings" },
      { label: "settings:providers_docConfig", href: "https://pi.dev/docs/latest/settings" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "piBinaryPath",
        label: "settings:piBinaryPath",
        placeholder: "settings:piBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "pi" }}
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "piAgentDir",
        label: "settings:providers_piAgentDir",
        placeholder: "settings:providers_piAgentDir",
        description: "settings:providers_piAgentDirDescription",
      },
    ],
  },
  {
    provider: "omp",
    docs: [
      { label: "workspace:docs", href: "https://omp.sh/docs" },
      { label: "settings:providers_docInstall", href: "https://omp.sh/docs/quickstart" },
      {
        label: "common:workspaceFilePreviewHeader_source",
        href: "https://github.com/can1357/oh-my-pi",
      },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "ompBinaryPath",
        label: "settings:ohMyPiBinaryPath",
        placeholder: "settings:ohMyPiBinaryPath",
        description: () => (
          <Translation
            message="settings:binaryPathDescription"
            values={{ command: "omp" }}
            components={{ command: <code /> }}
          />
        ),
      },
      {
        kind: "text",
        settingsKey: "ompAgentDir",
        label: "settings:ohMyPiAgentDirectory",
        placeholder: "settings:ohMyPiAgentDirectory",
        description: "settings:optionalCustomOhMyPiAgentDirectoryForAuth",
      },
    ],
  },
];

// Beta-only providers keep their stored install fields but
// their install row is hidden.
const VISIBLE_PROVIDER_INSTALL_SETTINGS = PROVIDER_INSTALL_SETTINGS.filter((config) =>
  isBetaFeatureOn(config.provider),
);

function isProviderInstallFieldDirty(
  field: ProviderInstallField,
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return field.kind === "password"
    ? settings[field.configuredKey] !== defaults[field.configuredKey]
    : settings[field.settingsKey] !== defaults[field.settingsKey];
}

function isProviderInstallConfigDirty(
  config: ProviderInstallSettings,
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return (
    config.fields.some((field) => isProviderInstallFieldDirty(field, settings, defaults)) ||
    JSON.stringify(
      Object.fromEntries(
        Object.entries(settings.providerInstances).filter(
          ([, instance]) => instance.driver === config.provider,
        ),
      ),
    ) !==
      JSON.stringify(
        Object.fromEntries(
          Object.entries(defaults.providerInstances).filter(
            ([, instance]) => instance.driver === config.provider,
          ),
        ),
      ) ||
    (config.provider === "codex" &&
      (settings.selectedCodexAccountId !== defaults.selectedCodexAccountId ||
        JSON.stringify(settings.codexAccounts) !== JSON.stringify(defaults.codexAccounts)))
  );
}

export function isProviderInstallSettingsDirty(
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return PROVIDER_INSTALL_SETTINGS.some((config) =>
    isProviderInstallConfigDirty(config, settings, defaults),
  );
}

function createProviderInstallDisclosureState(
  settings: AppSettings,
): Record<ProviderKind, boolean> {
  return Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.map((config) => [
      config.provider,
      config.fields.some((field) =>
        field.kind === "password"
          ? settings[field.configuredKey]
          : Boolean(settings[field.settingsKey]),
      ) ||
        Object.values(settings.providerInstances).some(
          (instance) => instance.driver === config.provider,
        ) ||
        (config.provider === "codex" &&
          (settings.codexAccounts.length > 0 ||
            settings.selectedCodexAccountId !== DEFAULT_CODEX_ACCOUNT_ID)),
    ]),
  ) as Record<ProviderKind, boolean>;
}

function createClosedProviderInstallDisclosureState(): Record<ProviderKind, boolean> {
  return Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.map((config) => [config.provider, false]),
  ) as Record<ProviderKind, boolean>;
}

export function createProviderInstallResetPatch(defaults: AppSettings): Partial<AppSettings> {
  const fieldPatch = Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.flatMap((config) =>
      config.fields.map((field) => [field.settingsKey, defaults[field.settingsKey]]),
    ),
  ) as Partial<AppSettings>;
  return {
    ...fieldPatch,
    codexAccounts: defaults.codexAccounts,
    selectedCodexAccountId: defaults.selectedCodexAccountId,
    providerInstances: defaults.providerInstances,
  };
}

function setProviderListMembership(
  current: ReadonlyArray<ProviderKind>,
  provider: ProviderKind,
  included: boolean,
): ProviderKind[] {
  const withoutTarget = current.filter((entry) => entry !== provider);
  return included ? [...withoutTarget, provider] : withoutTarget;
}

function isProviderPickerProviderEnabled(
  providerStatus: Pick<ServerProviderStatus, "available"> | null | undefined,
  isHidden: boolean,
): boolean {
  return providerStatus?.available === true && !isHidden;
}

function SortableProviderVisibilityRow(props: {
  option: { provider: ProviderKind; title: string };
  providerStatus: ServerProviderStatus | undefined;
  statusReconciled: boolean;
  isDisabled: boolean;
  isHidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
}) {
  const { t } = useTranslation();

  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.option.provider });
  const isChecking = !props.statusReconciled || props.providerStatus === undefined;
  const isAvailable = props.providerStatus?.available === true;
  const isEnabled = isProviderPickerProviderEnabled(props.providerStatus, props.isHidden);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
        "flex items-center justify-between gap-3 px-3 py-2.5",
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className={cn(
            "inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground active:cursor-grabbing",
            ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME,
            SETTINGS_INSET_RADIUS_CLASS_NAME,
          )}
          aria-label={t("workspace:reorder", { value0: props.option.title })}
          {...attributes}
          {...listeners}
        >
          <CentralIcon name="dot-grid-2x3" className="size-4" />
        </button>
        <ProviderIcon provider={props.option.provider} className="size-4 shrink-0" />
        <span className="min-w-0">
          <span className="block truncate text-ui-lg leading-snug text-foreground">
            {props.option.title}
          </span>
          <span className="block text-ui-sm text-muted-foreground">
            {providerSetupStatusLabel(
              {
                status: props.providerStatus,
                reconciled: props.statusReconciled,
                disabled: props.isDisabled,
              },
              t,
            )}
          </span>
        </span>
      </div>
      <Switch
        checked={isEnabled}
        disabled={isChecking || !isAvailable}
        onCheckedChange={(checked) => props.onHiddenChange(!Boolean(checked))}
        aria-label={
          isChecking
            ? t("settings:checkingCLIAvailability", { value0: props.option.title })
            : isAvailable
              ? t("settings:showInTheProviderPicker", { value0: props.option.title })
              : t("settings:isUnavailableInTheProviderPicker", {
                  value0: props.option.title,
                })
        }
      />
    </div>
  );
}

function ProviderDocsLinks({ docs }: { docs: ProviderInstallSettings["docs"] }) {
  const { t } = useTranslation();

  return (
    <div className={cn(SETTINGS_OUTLINED_SURFACE_CLASS_NAME, "px-3 py-2.5")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-ui leading-snug font-medium text-foreground">
          {t("settings:providers_cliDocs")}
        </span>
        <div className="flex flex-wrap gap-2">
          {docs.map((doc) => (
            <Button
              key={`${doc.label}:${doc.href}`}
              variant="outline"
              size="sm"
              render={<a href={doc.href} target="_blank" rel="noreferrer" />}
            >
              <span>{t(doc.label)}</span>
              <ExternalLinkIcon className="size-3" />
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatProviderVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function providerUpdateStatusLabel(provider: ServerProviderStatus): string | null {
  const state = provider.updateState?.status;
  if (state === "queued") return t("settings:updateQueued");
  if (state === "running") return t("settings:providers_updating");
  if (state === "succeeded") return t("common:updated");
  if (state === "failed") return t("common:providerUpdates_failed");
  if (state === "unchanged") return t("settings:stillOutdated");
  const advisory = provider.versionAdvisory;
  if (advisory?.status === "behind_latest" && advisory.latestVersion) {
    const currentVersion = formatProviderVersion(advisory.currentVersion);
    const latestVersion = formatProviderVersion(advisory.latestVersion);
    return currentVersion
      ? t("settings:symbol", { value0: currentVersion, value1: latestVersion })
      : t("settings:latest", { value0: latestVersion });
  }
  const currentVersion = formatProviderVersion(provider.version);
  return currentVersion ? t("settings:current", { value0: currentVersion }) : null;
}

function providerUpdateFailureMessage(provider: ServerProviderStatus | undefined): string | null {
  const state = provider?.updateState;
  if (!state || (state.status !== "failed" && state.status !== "unchanged")) return null;
  return state.output?.trim() || state.message || t("settings:theProviderUpdateDidNotComplete");
}

function providerStatusDisplayName(status: ServerProviderStatus): string {
  if (status.displayName?.trim()) return status.displayName;
  const driver = status.driver ?? status.provider;
  return isProviderKind(driver) ? PROVIDER_DISPLAY_NAMES[driver] : driver;
}

function ProviderUpdateAction(props: {
  providerStatus: ServerProviderStatus;
  active: boolean;
  disabled: boolean;
  onUpdate: (provider: ProviderKind, instanceId?: ProviderInstanceId) => void;
}) {
  const { t } = useTranslation();

  const advisory = props.providerStatus.versionAdvisory;
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={props.disabled}
      title={
        advisory?.updateCommand ? t("workspace:run", { value0: advisory.updateCommand }) : undefined
      }
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        const driver = props.providerStatus.driver ?? props.providerStatus.provider;
        if (!isProviderKind(driver)) return;
        props.onUpdate(driver, providerStatusInstanceKey(props.providerStatus));
      }}
    >
      {props.active ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <DownloadIcon className="size-3.5" />
      )}
      {props.active ? t("settings:providers_updating") : t("computer:providerUpdates_update")}
    </Button>
  );
}

function ProviderInstallFieldControl(props: {
  field: ProviderInstallField;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const { t } = useTranslation();

  const id = `provider-install-${props.field.settingsKey}`;
  if (props.field.kind === "boolean") {
    return (
      <label
        htmlFor={id}
        className="flex items-start justify-between gap-3 rounded-md border border-border/70 bg-background/60 px-3 py-2"
      >
        <span className="min-w-0">
          <span className="block text-ui leading-snug font-medium text-foreground">
            {t(props.field.label)}
          </span>
          <span className="mt-1 block text-ui leading-snug text-muted-foreground">
            {typeof props.field.description === "string"
              ? t(props.field.description)
              : props.field.description(t)}
          </span>
        </span>
        <Switch
          id={id}
          checked={props.settings[props.field.settingsKey]}
          onCheckedChange={(checked) =>
            props.updateSettings({ [props.field.settingsKey]: Boolean(checked) })
          }
        />
      </label>
    );
  }

  const configured =
    props.field.kind === "password" ? props.settings[props.field.configuredKey] : false;
  const isPassword = props.field.kind === "password";
  return (
    <label htmlFor={id} className="block">
      <span className="block text-ui leading-snug font-medium text-foreground">
        {t(props.field.label)}
      </span>
      <DebouncedSettingTextInput
        id={id}
        size="sm"
        variant="soft"
        className="mt-1"
        value={isPassword ? "" : props.settings[props.field.settingsKey]}
        onCommit={(nextValue) =>
          props.updateSettings({ [props.field.settingsKey]: nextValue } as Partial<AppSettings>)
        }
        placeholder={
          isPassword && configured
            ? t("settings:configuredEnterAReplacementOrLeaveBlank")
            : t(props.field.placeholder)
        }
        type={isPassword ? "password" : undefined}
        autoComplete={isPassword ? "new-password" : undefined}
        spellCheck={false}
      />
      <span className="mt-1 block text-ui leading-snug text-muted-foreground">
        {typeof props.field.description === "string"
          ? t(props.field.description)
          : props.field.description(t)}
      </span>
    </label>
  );
}

// Settings written before accounts became provider instances also store which Codex
// account new threads start on. Only those settings still need the choice surfaced.
function CodexDefaultAccountControl(props: {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const { t } = useTranslation();

  // The default account goes by the provider's name here too, as in the account list.
  const accountOptions = getCodexAccountOptions(props.settings).map((account) =>
    account.isDefault ? { ...account, label: PROVIDER_DISPLAY_NAMES.codex } : account,
  );
  const selectedAccountLabel =
    accountOptions.find((account) => account.id === props.settings.selectedCodexAccountId)?.label ??
    PROVIDER_DISPLAY_NAMES.codex;

  return (
    <div className="space-y-1">
      <span className="block text-ui-sm font-medium text-foreground">
        {t("settings:codexAccountForNewThreads")}
      </span>
      <SettingsSelectControl
        value={props.settings.selectedCodexAccountId}
        onValueChange={(selectedCodexAccountId) => props.updateSettings({ selectedCodexAccountId })}
        ariaLabel={t("settings:codexAccountForNewThreads")}
        triggerClassName="w-full"
        valueContent={<span className="truncate">{selectedAccountLabel}</span>}
      >
        {accountOptions.map((account) => (
          <SelectItem hideIndicator key={account.id} value={account.id}>
            <span className="truncate">{account.label}</span>
          </SelectItem>
        ))}
      </SettingsSelectControl>
      <span className="block text-ui-sm text-muted-foreground">
        {t("settings:usedUntilYouPickAnotherAccountInTheModel")}
      </span>
    </div>
  );
}

// Null for a provider-wide setting that no account config carries.
function providerInstanceConfigKey(field: ProviderInstallField): string | null {
  switch (field.settingsKey) {
    case "codexHomePath":
    case "claudeHomePath":
      return "homePath";
    case "cursorApiEndpoint":
      return "apiEndpoint";
    case "openCodeServerUrl":
      return "serverUrl";
    case "openCodeServerPassword":
      return "serverPassword";
    case "openCodeExperimentalWebSockets":
      return "experimentalWebSockets";
    // Launch arguments and these Claude options are provider-wide settings,
    // not account executable paths or account-specific config fields.
    case "codexLaunchArgs":
    case "claudeEnableArtifacts":
    case "claudeConfirmColdCacheResume":
      return null;
    case "piAgentDir":
    case "ompAgentDir":
      return "agentDir";
    default:
      return "binaryPath";
  }
}

/** Launch config a new instance inherits from the provider's current install fields. */
export function providerInstanceLaunchConfigFor(
  provider: ProviderKind,
  settings: AppSettings,
): Record<string, unknown> {
  const config = PROVIDER_INSTALL_SETTINGS.find((entry) => entry.provider === provider);
  return config ? providerInstanceLaunchConfig(config, settings) : {};
}

function providerInstanceLaunchConfig(
  config: ProviderInstallSettings,
  settings: AppSettings,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of config.fields) {
    const key = providerInstanceConfigKey(field);
    if (key === null) continue;
    const value = settings[field.settingsKey];
    if (typeof value === "boolean") {
      if (value) result[key] = true;
      continue;
    }
    if (value.trim()) result[key] = value;
  }
  // A home names an account's identity: inheriting the default's would sign the new
  // account in as the default one.
  if (config.provider === "codex" || config.provider === "claudeAgent") {
    delete result.homePath;
  }
  return result;
}

// Paths that give a new account its own identity; asked for when adding one.
function providerAccountIdentityFields(
  provider: ProviderKind,
): ReadonlyArray<AddProviderAccountConfigField> {
  if (provider === "codex") {
    return [
      {
        key: "homePath",
        label: t("settings:providers_codexHomePath"),
        placeholder: "~/.codex-work",
        description: t("settings:leaveBlankAndSynaraKeepsThisAccountSSign"),
      },
    ];
  }
  if (provider === "claudeAgent") {
    return [
      {
        key: "configDir",
        label: t("settings:claudeConfigDirectory"),
        placeholder: "~/.claude-work",
        description:
          "Leave blank and Synara keeps this account's sign-in in its own folder. " +
          "Set a directory to use a Claude config folder you already signed in to.",
      },
    ];
  }
  if (provider === "pi" || provider === "omp") return [];
  return [
    {
      key: "profileDir",
      label: t("settings:profileDirectory"),
      placeholder: t("settings:providerAccountDirectory"),
      description: t("settings:usedAsThisAccountSProviderConfigRootWithout"),
    },
  ];
}

const ACCOUNT_STATUS_PILL_CLASS_NAME: Record<ProviderAccountStatusTone, string> = {
  ready: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  warning: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  error: "bg-red-500/12 text-red-700 dark:text-red-300",
  idle: "bg-muted text-muted-foreground",
};

const ACCOUNT_STATUS_DOT_CLASS_NAME: Record<ProviderAccountStatusTone, string> = {
  ready: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
  idle: "bg-muted-foreground/40",
};

const ProviderSignInDialog = lazy(() => import("./ProviderSignInDialog"));

function ProviderAccountsControl(props: {
  config: ProviderInstallSettings;
  providerStatusByInstance: ReadonlyMap<string, ServerProviderStatus>;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();

  const provider = props.config.provider;
  const providerLabel = PROVIDER_DISPLAY_NAMES[provider];
  const usageQuery = useQuery(
    serverAllProviderUsageQueryOptions({ enabled: provider === "claudeAgent" }),
  );
  const usageByInstance = useMemo(
    () =>
      new Map(
        (usageQuery.data ?? []).map((snapshot) => [
          snapshot.instanceId ?? snapshot.provider,
          snapshot,
        ]),
      ),
    [usageQuery.data],
  );
  const allAccounts = getProviderInstanceOptions(props.settings);
  // Default first, then the provider's other accounts by name.
  const accounts = allAccounts.filter((account) => account.provider === provider);
  const manageableById = new Map(
    getManageableProviderInstances(props.settings, provider).map((entry) => [
      String(entry.instanceId),
      entry,
    ]),
  );
  const [selectedAccountId, setSelectedAccountId] = useState<string>(provider);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [signInAccount, setSignInAccount] = useState<ProviderInstanceOption | null>(null);
  const [startingSignIn, setStartingSignIn] = useState(false);
  const signInPendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const startSignIn = async (account: ProviderInstanceOption) => {
    if (signInPendingRef.current) return;
    signInPendingRef.current = true;
    setStartingSignIn(true);
    try {
      // This is queued behind edits already being saved; the server must see
      // the account's latest settings before it resolves the login environment.
      await props.updateSettingsAndWait({});
      if (mountedRef.current) setSignInAccount(account);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:unableToStartSignIn"),
        description:
          error instanceof Error ? error.message : t("settings:unableToSaveProviderSettings"),
      });
    } finally {
      signInPendingRef.current = false;
      if (mountedRef.current) setStartingSignIn(false);
    }
  };
  const selectedAccount =
    accounts.find((account) => account.instanceId === selectedAccountId) ?? accounts[0];

  const terminalCommandCounts = allAccounts.reduce((counts, option) => {
    const config = props.settings.providerInstances[String(option.instanceId)]?.config;
    const command = providerCliCommandName({
      provider: option.provider,
      instanceId: option.instanceId,
      config:
        config && typeof config === "object" && !Array.isArray(config)
          ? (config as Record<string, unknown>)
          : undefined,
    });
    counts.set(command, (counts.get(command) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  const updateInstances = (next: Record<string, ProviderInstanceConfig>) => {
    props.updateSettings({ providerInstances: next as ProviderInstanceConfigMap });
  };
  const addAccount = (input: AddProviderAccountInput) => {
    const installConfig = PROVIDER_INSTALL_SETTINGS.find(
      (entry) => entry.provider === input.provider,
    );
    updateInstances({
      ...props.settings.providerInstances,
      [input.instanceId]: {
        driver: input.provider,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        enabled: true,
        config: {
          // A new account starts from the provider's own binary and endpoint settings.
          ...(installConfig ? providerInstanceLaunchConfig(installConfig, props.settings) : {}),
          ...input.config,
        },
      },
    });
    if (input.provider === provider) setSelectedAccountId(input.instanceId);
    toastManager.add({
      type: "success",
      title: t("settings:accountAdded"),
      description: t("settings:accountWasAdded", {
        value0: PROVIDER_DISPLAY_NAMES[input.provider],
        value1: input.displayName || input.instanceId,
      }),
    });
  };
  const nextImportedInstanceId = () => {
    const prefix = provider === "claudeAgent" ? "claude" : provider;
    const existingIds = new Set(allAccounts.map((option) => String(option.instanceId)));
    let index = 2;
    while (existingIds.has(`${prefix}_${index}`)) index += 1;
    return `${prefix}_${index}`;
  };
  const importInstance = async () => {
    const selectedDirectory = await ensureNativeApi().dialogs.pickFolder();
    if (!selectedDirectory) return;
    // Derived accounts share this namespace with explicit entries. Reusing a
    // derived id would mutate that account instead of creating a new one.
    const instanceId = nextImportedInstanceId();
    const directoryName = selectedDirectory.split(/[\\/]/).filter(Boolean).at(-1);
    updateInstances({
      ...props.settings.providerInstances,
      [instanceId]: {
        driver: provider,
        displayName: directoryName || `${providerLabel} imported`,
        enabled: true,
        config: {
          ...providerInstanceLaunchConfig(props.config, props.settings),
          ...providerImportedDirectoryConfig(provider, selectedDirectory),
        },
      },
    });
    setSelectedAccountId(instanceId);
    toastManager.add({
      type: "success",
      title: t("settings:accountImported", { value0: providerLabel }),
      description: t("settings:synaraReferencesTheSelectedDirectoryNoFilesWereMoved"),
    });
  };
  const updateInstance = (
    instanceId: string,
    patch: ProviderInstancePatch,
    legacyCodexAccountId: string | null = null,
  ) => {
    const settingsPatch = buildProviderInstanceSettingsPatch(
      props.settings,
      instanceId,
      patch,
      legacyCodexAccountId,
    );
    if (settingsPatch) props.updateSettings(settingsPatch);
  };
  // Restore appearance and enablement while retaining the account's name and launch overrides.
  const resetDefaultAccount = () => {
    const explicit = props.settings.providerInstances[provider];
    if (!explicit) return;
    const { accentColor: _accentColor, enabled: _enabled, ...rest } = explicit;
    const next = { ...props.settings.providerInstances } as Record<string, ProviderInstanceConfig>;
    if (Object.keys(rest).length > 1) {
      next[provider] = rest;
    } else {
      delete next[provider];
    }
    updateInstances(next);
  };
  const readConfigString = (config: unknown, key: string): string => {
    if (!config || typeof config !== "object" || Array.isArray(config)) return "";
    const value = (config as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  };
  const readConfigBoolean = (config: unknown, key: string): boolean => {
    if (!config || typeof config !== "object" || Array.isArray(config)) return false;
    return (config as Record<string, unknown>)[key] === true;
  };
  const isAccountProvider = provider === "codex" || provider === "claudeAgent";
  // Launch details most accounts never touch; kept behind the editor's Advanced disclosure.
  const isAdvancedField = (field: ProviderInstallField) =>
    field.kind === "boolean" ||
    providerInstanceConfigKey(field) === "binaryPath" ||
    field.settingsKey === "claudeHomePath";

  const renderField = (
    field: ProviderInstallField,
    { instanceId, instance, legacyCodexAccountId }: ManageableProviderInstance,
  ) => {
    const configKey = providerInstanceConfigKey(field);
    if (configKey === null) return null;
    if (field.kind === "boolean") {
      return (
        <label
          key={field.settingsKey}
          className="flex items-center justify-between gap-3 sm:col-span-2"
        >
          <span className="text-ui-sm font-medium text-foreground">{t(field.label)}</span>
          <Switch
            checked={readConfigBoolean(instance.config, configKey)}
            onCheckedChange={(checked) =>
              updateInstance(instanceId, { config: { [configKey]: checked } })
            }
            aria-label={t("settings:for", {
              value0: t(field.label),
              value1: instance.displayName || instanceId,
            })}
          />
        </label>
      );
    }
    const redacted =
      field.kind === "password" &&
      instance.config !== null &&
      typeof instance.config === "object" &&
      !Array.isArray(instance.config) &&
      (instance.config as Record<string, unknown>)[`${configKey}Redacted`] === true;
    const inputId = `provider-instance-${instanceId}-${configKey}`;
    return (
      <div className="block" key={field.settingsKey}>
        <label htmlFor={inputId} className="block text-ui-sm font-medium text-foreground">
          {t(field.label)}
        </label>
        <div className="mt-1 flex items-center gap-2">
          <DebouncedSettingTextInput
            id={inputId}
            size="sm"
            variant="soft"
            className="flex-1"
            type={field.kind === "password" ? "password" : "text"}
            value={redacted ? "" : readConfigString(instance.config, configKey)}
            onCommit={(value) => {
              if (redacted && value.length === 0) return;
              updateInstance(instanceId, { config: { [configKey]: value } }, legacyCodexAccountId);
            }}
            placeholder={redacted ? t("settings:secretSavedTypeToReplace") : t(field.placeholder)}
            spellCheck={false}
          />
          {redacted ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => updateInstance(instanceId, { config: { [configKey]: "" } })}
              aria-label={t("settings:clearSavedFor", {
                value0: t(field.label).toLowerCase(),
                value1: instance.displayName || instanceId,
              })}
            >
              {t("chat:clear")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  const renderAccountRuntime = (entry: ManageableProviderInstance, cliCommand: string) => {
    const { instanceId, instance, legacyCodexAccountId } = entry;
    const cliAlias = readConfigString(instance.config, "cliAlias");
    const cliAliasInvalid =
      cliAlias.length > 0 && normalizeProviderCliAlias(cliAlias) === undefined;
    const cliCommandConflicts = (terminalCommandCounts.get(cliCommand) ?? 0) > 1;
    return (
      <>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="block text-ui-sm font-medium text-foreground">
              {t("settings:terminalCommand")}
            </span>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border/70 bg-background/60 px-2.5 py-1.5 text-ui-sm">
                {cliCommand}
              </code>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={t("settings:copy", { value0: cliCommand })}
                onClick={() => void copyTextToClipboard(cliCommand)}
              >
                <CopyIcon className="size-3.5" />
              </Button>
            </div>
          </label>
          {props.config.fields
            .filter((field) => !isAdvancedField(field))
            .map((field) => renderField(field, entry))}
          {provider === "codex" ? (
            <label className="block">
              <span className="block text-ui-sm font-medium text-foreground">
                {t("settings:shadowAuthHome")}
              </span>
              <DebouncedSettingTextInput
                id={`provider-instance-${instanceId}-shadow-home`}
                size="sm"
                variant="soft"
                className="mt-1"
                value={readConfigString(instance.config, "shadowHomePath")}
                onCommit={(shadowHomePath) =>
                  updateInstance(instanceId, { config: { shadowHomePath } }, legacyCodexAccountId)
                }
                placeholder="~/.codex_work"
                spellCheck={false}
              />
            </label>
          ) : null}
          {provider === "claudeAgent" ? (
            <label className="block sm:col-span-2">
              <span className="block text-ui-sm font-medium text-foreground">
                {t("settings:claudeConfigDirectory")}
              </span>
              <DebouncedSettingTextInput
                id={`provider-instance-${instanceId}-config-dir`}
                size="sm"
                variant="soft"
                className="mt-1"
                value={readConfigString(instance.config, "configDir")}
                onCommit={(configDir) => updateInstance(instanceId, { config: { configDir } })}
                placeholder="~/.claude-work"
                spellCheck={false}
              />
            </label>
          ) : null}
          {isAccountProvider ? (
            <span className="block text-ui-sm text-muted-foreground sm:col-span-2">
              {provider === "codex"
                ? "Leave both paths blank and Synara keeps this account's sign-in in its " +
                  "own folder. Set a shadow auth home to keep only the sign-in elsewhere " +
                  "while sharing settings and history with the default account, or a " +
                  "CODEX_HOME to keep everything separate."
                : "Leave blank and Synara keeps this account's sign-in in its own folder. " +
                  "Set a directory to use a Claude config folder you already signed in to."}
            </span>
          ) : null}
          {!isAccountProvider && provider !== "pi" && provider !== "omp" ? (
            <label className="block sm:col-span-2">
              <span className="block text-ui-sm font-medium text-foreground">
                {t("settings:profileDirectory")}
              </span>
              <DebouncedSettingTextInput
                id={`provider-instance-${instanceId}-profile-dir`}
                size="sm"
                variant="soft"
                className="mt-1"
                value={readConfigString(instance.config, "profileDir")}
                onCommit={(profileDir) => updateInstance(instanceId, { config: { profileDir } })}
                placeholder={t("settings:providerAccountDirectory")}
                spellCheck={false}
              />
              <span className="mt-1 block text-ui-sm text-muted-foreground">
                {t("settings:usedAsThisAccountSProviderConfigRootWithout")}
              </span>
            </label>
          ) : null}
        </div>
        <ProviderInstanceAdvancedSection>
          <label className="block sm:col-span-2">
            <span className="block text-ui-sm font-medium text-foreground">
              {t("settings:commandOverride")}
            </span>
            <DebouncedSettingTextInput
              id={`provider-instance-${instanceId}-cli-alias`}
              size="sm"
              variant="soft"
              className="mt-1"
              value={cliAlias}
              onCommit={(cliAlias) => updateInstance(instanceId, { config: { cliAlias } })}
              placeholder={cliCommand}
              spellCheck={false}
            />
            <span
              className={cn(
                "mt-1 block text-ui-sm",
                cliAliasInvalid || cliCommandConflicts
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {cliAliasInvalid
                ? t("settings:use164LettersNumbersDashesOrUnderscoresBare")
                : cliCommandConflicts
                  ? t("settings:thisCommandIsAlreadyAssignedToAnotherAccountChoose")
                  : t("settings:availableInSynaraTerminalsForZshBashFishAnd")}
            </span>
          </label>
          {props.config.fields.filter(isAdvancedField).map((field) => renderField(field, entry))}
          {provider === "claudeAgent" ? (
            <label className="block">
              <span className="block text-ui-sm font-medium text-foreground">
                {t("settings:claudeCredentialDirectory")}
              </span>
              <DebouncedSettingTextInput
                id={`provider-instance-${instanceId}-secure-storage-dir`}
                size="sm"
                variant="soft"
                className="mt-1"
                value={readConfigString(instance.config, "secureStorageDir")}
                onCommit={(secureStorageDir) =>
                  updateInstance(instanceId, { config: { secureStorageDir } })
                }
                placeholder={t("settings:optionalSharedCredentialDirectory")}
                spellCheck={false}
              />
              <span className="mt-1 block text-ui-sm text-muted-foreground">
                {t("settings:leaveBlankUnlessYourSetupAlreadyUsesASeparate")}
              </span>
            </label>
          ) : null}
        </ProviderInstanceAdvancedSection>
      </>
    );
  };

  const renderEditor = (account: ProviderInstanceOption) => {
    const instanceId = String(account.instanceId);
    const manageable = manageableById.get(instanceId) ?? null;
    const explicit = props.settings.providerInstances[instanceId];
    const legacyCodexAccountId = manageable?.legacyCodexAccountId ?? null;
    const liveStatus = props.providerStatusByInstance.get(instanceId);
    const status = providerAccountStatusSummary(
      {
        status: liveStatus,
        enabled: account.enabled,
        usageSnapshot: usageByInstance.get(instanceId),
      },
      t,
    );
    const cliCommand = account.isDefault
      ? provider === "claudeAgent"
        ? "claude"
        : provider
      : providerCliCommandName({
          provider,
          instanceId: account.instanceId,
          config:
            manageable?.instance.config &&
            typeof manageable.instance.config === "object" &&
            !Array.isArray(manageable.instance.config)
              ? (manageable.instance.config as Record<string, unknown>)
              : undefined,
        });
    const defaultIsCustomized =
      account.isDefault &&
      explicit !== undefined &&
      (explicit.accentColor !== undefined || explicit.enabled === false);
    return (
      <div
        className={cn(
          SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
          SETTINGS_INSET_RADIUS_CLASS_NAME,
          "min-w-0 flex-1 overflow-hidden",
        )}
        // Remount per account so a pending debounced edit can never land on another one.
        key={instanceId}
        role="group"
        aria-label={t("settings:account", { value0: account.label })}
      >
        <div className="flex items-start gap-3 border-b border-border/70 bg-muted/25 px-3 py-3">
          <ProviderAccountAvatar provider={provider} accentColor={account.accentColor} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-ui-lg font-medium text-foreground">
                {account.label}
              </span>
              {account.isDefault ? (
                <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-px text-ui-2xs font-medium text-muted-foreground">
                  {t("settings:reasoningModes_default")}
                </span>
              ) : null}
            </div>
            <StatusChip
              variant="pill"
              className={cn("mt-1 w-fit max-w-full", ACCOUNT_STATUS_PILL_CLASS_NAME[status.tone])}
              dotClassName={ACCOUNT_STATUS_DOT_CLASS_NAME[status.tone]}
            >
              <span className="truncate">{status.headline}</span>
            </StatusChip>
          </div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!account.enabled || liveStatus?.available === false || startingSignIn}
            aria-label={t("settings:signInTo2", { value0: account.label })}
            onClick={() => void startSignIn(account)}
          >
            {startingSignIn ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <PlayIcon className="size-3.5" />
            )}
            {t("chat:providerModelPicker_signIn")}
          </Button>
          {account.isDefault ? (
            defaultIsCustomized ? (
              <SettingResetButton
                label={t("settings:account", { value0: account.label })}
                onClick={resetDefaultAccount}
              />
            ) : null
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                props.updateSettings(removeManageableProviderInstance(props.settings, instanceId));
                setSelectedAccountId(provider);
              }}
            >
              <XIcon className="size-3.5" />
              {t("workspace:edit_remove")}
            </Button>
          )}
        </div>

        {status.detail && status.tone !== "ready" && status.tone !== "idle" ? (
          <div className="border-b border-border/70 px-3 py-2 text-ui-sm text-muted-foreground">
            {liveStatus?.authStatus === "unauthenticated"
              ? t("settings:useSignInToAuthenticateThisAccountThenComplete")
              : status.detail}
          </div>
        ) : null}

        <ProviderAccountEditorSection title={t("settings:identity")}>
          <div className="space-y-3">
            <div className="space-y-1">
              <label
                htmlFor={`provider-instance-${instanceId}-label`}
                className="block text-ui-sm font-medium text-foreground"
              >
                {t("common:edit_displayName")}
              </label>
              <DebouncedSettingTextInput
                id={`provider-instance-${instanceId}-label`}
                size="sm"
                variant="soft"
                value={
                  account.isDefault
                    ? (explicit?.displayName ?? "")
                    : (manageable?.instance.displayName ?? "")
                }
                onCommit={(displayName) =>
                  updateInstance(instanceId, { displayName }, legacyCodexAccountId)
                }
                placeholder={account.isDefault ? providerLabel : t("common:work")}
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <span className="block text-ui-sm font-medium text-foreground">
                {t("settings:accentColor")}
              </span>
              <div className="flex min-h-7 items-center">
                <ProviderAccentColorControl
                  value={account.accentColor}
                  accountLabel={account.label}
                  onChange={(accentColor) =>
                    updateInstance(instanceId, { accentColor: accentColor ?? null })
                  }
                />
              </div>
            </div>
          </div>
        </ProviderAccountEditorSection>

        <ProviderAccountEditorSection title={t("settings:runtime")}>
          {account.isDefault ? (
            <div className="space-y-3">
              {props.config.fields.map((field) => (
                <ProviderInstallFieldControl
                  key={field.settingsKey}
                  field={field}
                  settings={props.settings}
                  updateSettings={props.updateSettings}
                />
              ))}
              {provider === "codex" && props.settings.codexAccounts.length > 0 ? (
                <CodexDefaultAccountControl
                  settings={props.settings}
                  updateSettings={props.updateSettings}
                />
              ) : null}
            </div>
          ) : manageable ? (
            renderAccountRuntime(manageable, cliCommand)
          ) : null}
        </ProviderAccountEditorSection>

        {/* A migrated Codex account is routed by its saved identity; an environment of
            its own would make the server drop that route, so none is offered. */}
        {legacyCodexAccountId === null ? (
          <ProviderAccountEditorSection title={t("chat:general_environmentPanel")}>
            <ProviderInstanceEnvironmentEditor
              instanceId={instanceId}
              environment={
                account.isDefault ? explicit?.environment : manageable?.instance.environment
              }
              onChange={(environment) => updateInstance(instanceId, { environment })}
            />
          </ProviderAccountEditorSection>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 sm:flex-nowrap">
        <div className="min-w-0">
          <span className="block text-ui-sm font-medium text-foreground">
            {providerLabel} {t("settings:accounts")}
          </span>
          <span className="mt-1 block text-ui-sm text-muted-foreground">
            {t("settings:eachAccountSignsInOnItsOwnAndGets2")}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={importInstance}
            disabled={typeof window === "undefined" || !window.desktopBridge}
            title={
              typeof window === "undefined" || !window.desktopBridge
                ? t("settings:directoryImportIsAvailableInTheSynaraDesktopApp")
                : t("settings:useAnExistingDirectoryAsANewAccountWithout", {
                    value0: providerLabel,
                  })
            }
          >
            <FolderOpenIcon className="size-3.5" />
            {t("settings:importDirectory")}
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => setAddDialogOpen(true)}>
            <PlusIcon className="size-3.5" />
            {t("settings:addAccount")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div
          role="list"
          aria-label={t("settings:accounts2", { value0: providerLabel })}
          className={cn(
            SETTINGS_INSET_LIST_CLASS_NAME,
            SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
            "shrink-0 md:w-60",
          )}
        >
          {accounts.map((account) => {
            const selected = account.instanceId === selectedAccount?.instanceId;
            const status = providerAccountStatusSummary(
              {
                status: props.providerStatusByInstance.get(account.instanceId),
                enabled: account.enabled,
                usageSnapshot: usageByInstance.get(account.instanceId),
              },
              t,
            );
            return (
              <div
                key={account.instanceId}
                role="listitem"
                className={cn(
                  "relative flex items-center gap-2 px-3 py-2.5 transition-colors",
                  selected
                    ? // The bar takes the account's accent, so the selection points at it.
                      "bg-muted/55 before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r-full before:bg-(--account-accent,var(--foreground))"
                    : "hover:bg-muted/25",
                  !account.enabled && !selected && "opacity-60",
                )}
                style={
                  normalizeProviderAccentColor(account.accentColor)
                    ? ({
                        "--account-accent": normalizeProviderAccentColor(account.accentColor),
                      } as CSSProperties)
                    : undefined
                }
              >
                <button
                  type="button"
                  aria-label={t("settings:select", { value0: account.label })}
                  aria-current={selected ? "true" : undefined}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
                  onClick={() => setSelectedAccountId(account.instanceId)}
                >
                  <ProviderAccountAvatar provider={provider} accentColor={account.accentColor} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-sm font-medium text-foreground">
                      {account.label}
                    </span>
                    <ProviderInstanceStatusLine status={status} />
                  </span>
                </button>
                <Switch
                  checked={account.enabled}
                  onCheckedChange={(enabled) =>
                    updateInstance(account.instanceId, { enabled: Boolean(enabled) })
                  }
                  aria-label={t("workspace:enable", { value0: account.label })}
                />
              </div>
            );
          })}
        </div>
        {selectedAccount ? renderEditor(selectedAccount) : null}
      </div>

      {signInAccount ? (
        <Suspense
          fallback={
            <p className="text-ui-sm text-muted-foreground">{t("settings:openingSignIn")}</p>
          }
        >
          <ProviderSignInDialog
            provider={provider}
            instanceId={String(signInAccount.instanceId)}
            accountLabel={signInAccount.label}
            onClose={() => setSignInAccount(null)}
          />
        </Suspense>
      ) : null}
      <AddProviderAccountDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        providers={PROVIDER_VISIBILITY_OPTIONS.filter(
          (option) => !props.settings.disabledProviders.includes(option.provider),
        ).map((option) => ({
          provider: option.provider,
          label: option.title,
        }))}
        initialProvider={provider}
        // Includes accounts of a missing driver, which the list does not show.
        existingIds={
          new Set([
            ...allAccounts.map((option) => String(option.instanceId)),
            ...Object.keys(props.settings.providerInstances),
          ])
        }
        configFieldsFor={providerAccountIdentityFields}
        onAdd={addAccount}
      />
    </div>
  );
}

function ProviderInstanceStatusLine(props: { status: ProviderAccountStatusSummary }) {
  return (
    <StatusChip
      className="text-ui-xs text-muted-foreground"
      dotClassName={ACCOUNT_STATUS_DOT_CLASS_NAME[props.status.tone]}
    >
      <span className="truncate">{props.status.headline}</span>
    </StatusChip>
  );
}

// One titled band of the account editor; bands are separated by hairlines.
function ProviderAccountEditorSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-b border-border/70 px-3 py-3 last:border-b-0">
      <h4 className="text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.title}
      </h4>
      {props.children}
    </section>
  );
}

function ProviderInstanceAdvancedSection(props: { children: ReactNode }) {
  const { t } = useTranslation();

  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        type="button"
        className="mt-3 flex items-center gap-1 text-ui-sm text-muted-foreground"
      >
        {t("settings:nav_advanced")}
        <DisclosureChevron open={open} className="size-3.5 shrink-0" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{props.children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ProviderToolRow(props: {
  config: ProviderInstallSettings;
  open: boolean;
  settings: AppSettings;
  defaults: AppSettings;
  hiddenProviderSet: ReadonlySet<ProviderKind>;
  serverSettings: Pick<
    ServerSettings,
    "providers" | "providerInstances" | "enableProviderUpdateChecks"
  > | null;
  providerStatus: ServerProviderStatus | undefined;
  providerStatusByInstance: ReadonlyMap<string, ServerProviderStatus>;
  updatingProviders: ReadonlySet<ProviderInstanceId>;
  onOpenChange: (open: boolean) => void;
  onUpdate: (provider: ProviderKind, instanceId?: ProviderInstanceId) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();

  const title = PROVIDER_DISPLAY_NAMES[props.config.provider];
  const isDirty = isProviderInstallConfigDirty(props.config, props.settings, props.defaults);
  const showProviderUpdateStatus = props.providerStatus
    ? shouldShowProviderUpdateStatus({
        provider: props.providerStatus,
        hiddenProviderSet: props.hiddenProviderSet,
        serverSettings: props.serverSettings,
      })
    : false;
  const updateAdvisory = props.providerStatus?.versionAdvisory;
  const providerUpdateSuppressed =
    updateAdvisory?.status === "behind_latest" && !showProviderUpdateStatus;
  const currentProviderVersion = formatProviderVersion(props.providerStatus?.version);
  const providerUpdateLabel = props.providerStatus
    ? !props.settings.enableProviderUpdateChecks
      ? currentProviderVersion
        ? t("settings:current", { value0: currentProviderVersion })
        : null
      : providerUpdateSuppressed
        ? null
        : providerUpdateStatusLabel(props.providerStatus)
    : null;
  const updateActive = Boolean(
    (props.providerStatus && isProviderUpdateActive(props.providerStatus)) ||
    props.updatingProviders.has(
      props.providerStatus
        ? providerStatusInstanceKey(props.providerStatus)
        : props.config.provider,
    ),
  );
  const showUpdateButton = props.providerStatus
    ? shouldPromptProviderUpdate(props.providerStatus) &&
      (showProviderUpdateStatus || updateAdvisory?.status === "unknown")
    : false;
  // Self-updating CLIs never report a latest version, so the update stays available
  // inside the panel rather than as a header badge that can never be satisfied.
  const showSelfManagedUpdate = props.providerStatus
    ? shouldOfferProviderUpdateAction(props.providerStatus) &&
      !isProviderLatestVersionKnowable(props.providerStatus)
    : false;

  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
      <div className="border-t border-border/70 first:border-t-0">
        <div className="flex min-h-11 items-center gap-2 px-3 py-2">
          <CollapsibleTrigger
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="min-w-0 flex-1 text-ui-lg font-medium text-foreground">{title}</span>
            {isDirty ? (
              <span className="shrink-0 text-ui-sm text-muted-foreground">
                {t("settings:schedule_custom")}
              </span>
            ) : null}
            {providerUpdateLabel ? (
              <span
                className={cn(
                  "shrink-0 text-ui-sm",
                  updateAdvisory?.status === "behind_latest"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {providerUpdateLabel}
              </span>
            ) : null}
            <DisclosureChevron
              open={props.open}
              className="size-4 shrink-0 text-muted-foreground"
            />
          </CollapsibleTrigger>
          {showUpdateButton && props.providerStatus ? (
            <ProviderUpdateAction
              providerStatus={props.providerStatus}
              active={updateActive}
              disabled={updateActive}
              onUpdate={props.onUpdate}
            />
          ) : null}
        </div>

        <CollapsiblePanel>
          <div className="border-t border-border/70 bg-muted/20 px-3 py-3">
            <div className="space-y-3">
              <ProviderDocsLinks docs={props.config.docs} />
              {showProviderUpdateStatus && updateAdvisory?.status === "behind_latest" ? (
                <div className="text-ui leading-snug text-muted-foreground">
                  {updateAdvisory.canUpdate && updateAdvisory.updateCommand ? (
                    <>
                      <span>{t("settings:command")} </span>
                      <code className="font-mono">{updateAdvisory.updateCommand}</code>
                    </>
                  ) : (
                    t("settings:providers_newerVersionAvailable")
                  )}
                </div>
              ) : null}
              {showSelfManagedUpdate && props.providerStatus ? (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-ui leading-snug text-muted-foreground">
                    {title} {t("settings:managesItsOwnReleasesSoSynaraCannotTellWhether")}
                  </div>
                  <ProviderUpdateAction
                    providerStatus={props.providerStatus}
                    active={updateActive}
                    disabled={updateActive}
                    onUpdate={props.onUpdate}
                  />
                </div>
              ) : null}
              <ProviderAccountsControl
                config={props.config}
                providerStatusByInstance={props.providerStatusByInstance}
                settings={props.settings}
                updateSettings={props.updateSettings}
                updateSettingsAndWait={props.updateSettingsAndWait}
              />
            </div>
          </div>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

export type ProvidersSettingsPanelProps = AppSettingsBinding & {
  readonly active: boolean;
  readonly providerTarget?: ProviderKind | null;
  readonly resetEpoch: number;
  readonly updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
};

export function ProvidersSettingsPanel({
  settings,
  defaults,
  updateSettings,
  updateSettingsAndWait,
  active,
  providerTarget = null,
  resetEpoch,
}: ProvidersSettingsPanelProps) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const localProviderStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const [refreshingProviders, setRefreshingProviders] = useState(false);
  const refreshProvidersInFlightRef = useRef(false);
  const providerStatusesReconciled = hasReconciledServerProviderStatuses(queryClient);
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const [openInstallProviders, setOpenInstallProviders] = useState<Record<ProviderKind, boolean>>(
    () => ({
      ...createProviderInstallDisclosureState(settings),
      ...(providerTarget ? { [providerTarget]: true } : {}),
    }),
  );
  const [updatingProviders, setUpdatingProviders] = useState<ReadonlySet<ProviderInstanceId>>(
    () => new Set(),
  );
  const providerEnablementMutationInFlightRef = useRef(false);
  const [providerEnablementMutationPending, setProviderEnablementMutationPending] = useState(false);
  const [disabledProvidersOpen, setDisabledProvidersOpen] = useState(false);
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const hiddenProviderCount = hiddenProviderSet.size;
  const disabledProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.disabledProviders),
    [settings.disabledProviders],
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
  const providerVisibilitySensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const enabledProviderOptions = orderedProviderVisibilityOptions.filter(
    (option) => !disabledProviderSet.has(option.provider),
  );
  const disabledProviderOptions = orderedProviderVisibilityOptions.filter((option) =>
    disabledProviderSet.has(option.provider),
  );
  const enabledProviderCount = enabledProviderOptions.length;
  const isProviderOrderDirty = !sameProviderOrder(settings.providerOrder, defaults.providerOrder);
  const providerStatusByProvider = useMemo(
    () =>
      new Map<ProviderKind, ServerProviderStatus>(
        localProviderStatuses.flatMap((status) => {
          const driver = status.driver ?? status.provider;
          return isProviderKind(driver) && providerStatusInstanceKey(status) === driver
            ? [[driver, status] as const]
            : [];
        }),
      ),
    [localProviderStatuses],
  );
  const providerStatusByInstance = useMemo(
    () =>
      new Map<string, ServerProviderStatus>(
        localProviderStatuses.map((status) => [providerStatusInstanceKey(status), status]),
      ),
    [localProviderStatuses],
  );
  const availableProviderCount = enabledProviderOptions.filter(
    (option) => providerStatusByProvider.get(option.provider)?.available === true,
  ).length;
  const visibleAvailableProviderCount = enabledProviderOptions.filter(
    (option) =>
      providerStatusByProvider.get(option.provider)?.available === true &&
      !hiddenProviderSet.has(option.provider),
  ).length;
  const hasPendingProviderStatuses =
    !providerStatusesReconciled ||
    enabledProviderOptions.some((option) => !providerStatusByProvider.has(option.provider));
  const providerUpdateServerSettings = useMemo(
    () =>
      serverSettingsQuery.data
        ? {
            ...serverSettingsQuery.data,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }
        : null,
    [serverSettingsQuery.data, settings.enableProviderUpdateChecks],
  );
  const outdatedProviderStatuses = useMemo(
    () =>
      getVisibleProviderUpdateStatuses({
        providers: serverConfigQuery.data?.providers ?? [],
        hiddenProviders: settings.hiddenProviders,
        serverSettings: providerUpdateServerSettings,
      }).filter(
        (status) => !disabledProviderSet.has((status.driver ?? status.provider) as ProviderKind),
      ),
    [
      disabledProviderSet,
      providerUpdateServerSettings,
      serverConfigQuery.data?.providers,
      settings.hiddenProviders,
    ],
  );
  const outdatedProviderCount = outdatedProviderStatuses.length;
  const installSettingsDirty = isProviderInstallSettingsDirty(settings, defaults);

  const updateProviderEnablement = useCallback(
    async (disabledProviders: ProviderKind[]) => {
      if (providerEnablementMutationInFlightRef.current) return;
      providerEnablementMutationInFlightRef.current = true;
      setProviderEnablementMutationPending(true);
      try {
        await updateSettingsAndWait({ disabledProviders });
      } finally {
        providerEnablementMutationInFlightRef.current = false;
        setProviderEnablementMutationPending(false);
      }
    },
    [updateSettingsAndWait],
  );

  useSettingsRestoreSignal(resetEpoch, () => {
    setOpenInstallProviders(createClosedProviderInstallDisclosureState());
    setDisabledProvidersOpen(false);
  });

  useEffect(() => {
    if (!active || !providerTarget) return;
    if (disabledProviderSet.has(providerTarget)) {
      setDisabledProvidersOpen(true);
    } else {
      setOpenInstallProviders((current) => ({ ...current, [providerTarget]: true }));
    }
  }, [active, disabledProviderSet, providerTarget]);

  const handleProviderOrderDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = settings.providerOrder.indexOf(active.id as ProviderKind);
      const toIndex = settings.providerOrder.indexOf(over.id as ProviderKind);
      if (fromIndex < 0 || toIndex < 0) return;
      updateSettings({ providerOrder: arrayMove([...settings.providerOrder], fromIndex, toIndex) });
    },
    [settings.providerOrder, updateSettings],
  );

  const runProviderUpdate = useCallback(
    async (provider: ProviderKind, instanceId?: ProviderInstanceId) => {
      const targetId = instanceId ?? provider;
      if (updatingProviders.has(targetId)) return;
      setUpdatingProviders((current) => new Set(current).add(targetId));
      await withProviderUpdateTimeout({
        provider,
        request: ensureNativeApi().server.updateProvider({
          provider,
          ...(instanceId ? { instanceId } : {}),
        }),
      })
        .then((result) => {
          const refreshedProvider = result.providers.find(
            (status) =>
              (status.driver ?? status.provider) === provider &&
              providerStatusInstanceKey(status) === targetId,
          );
          const failureMessage = providerUpdateFailureMessage(refreshedProvider);
          if (failureMessage) {
            const manualCommand = refreshedProvider?.versionAdvisory?.updateCommand?.trim();
            toastManager.add({
              type: "error",
              title: t("settings:couldNotUpdate", {
                value0: refreshedProvider
                  ? providerStatusDisplayName(refreshedProvider)
                  : PROVIDER_DISPLAY_NAMES[provider],
              }),
              description: manualCommand
                ? t("settings:copyTheCommandBelowToUpdateManuallyInA", {
                    value0: failureMessage,
                  })
                : failureMessage,
              ...(manualCommand ? { data: { copyText: manualCommand } } : {}),
            });
            return;
          }
          toastManager.add({
            type: "success",
            title: t("settings:updateFinished", {
              value0: refreshedProvider
                ? providerStatusDisplayName(refreshedProvider)
                : PROVIDER_DISPLAY_NAMES[provider],
            }),
            description: t("settings:newSessionsWillUseTheRefreshedProvider"),
          });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: t("settings:couldNotUpdate", { value0: PROVIDER_DISPLAY_NAMES[provider] }),
            description:
              error instanceof Error ? error.message : t("settings:theProviderUpdateFailed"),
          });
        })
        .finally(async () => {
          await queryClient
            .invalidateQueries({ queryKey: serverQueryKeys.config() })
            .catch(() => undefined);
          setUpdatingProviders((current) => {
            const next = new Set(current);
            next.delete(targetId);
            return next;
          });
        });
    },
    [queryClient, updatingProviders, t],
  );

  if (!active) return null;

  const refreshProviders = async () => {
    if (refreshProvidersInFlightRef.current) return;
    refreshProvidersInFlightRef.current = true;
    setRefreshingProviders(true);
    try {
      await refreshProviderStatuses();
    } finally {
      refreshProvidersInFlightRef.current = false;
      setRefreshingProviders(false);
    }
  };

  const renderProviderActivityRow = (option: (typeof PROVIDER_VISIBILITY_OPTIONS)[number]) => {
    const enabled = !disabledProviderSet.has(option.provider);
    const providerStatus = providerStatusByProvider.get(option.provider);
    return (
      <SettingsListRow
        key={option.provider}
        title={
          <span className="flex items-center gap-2">
            <ProviderIcon provider={option.provider} className="size-4 shrink-0" />
            <span>{option.title}</span>
          </span>
        }
        description={
          <>
            <span className="block">
              {providerSetupStatusLabel(
                {
                  status: providerStatus,
                  reconciled: providerStatusesReconciled,
                  disabled: !enabled,
                },
                t,
              )}
            </span>
            {enabled &&
            providerStatusesReconciled &&
            providerStatus?.message &&
            (providerStatus.status !== "ready" || providerStatus.authStatus !== "authenticated") ? (
              <span className="mt-1 block">{providerStatus.message}</span>
            ) : null}
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="xs"
              render={<a href={option.setupDocsHref} target="_blank" rel="noreferrer" />}
              aria-label={t("settings:setupGuide2", { value0: option.title })}
            >
              {t("settings:setupGuide")}
              <ExternalLinkIcon className="size-3" />
            </Button>
            <Switch
              checked={enabled}
              disabled={!serverSettingsQuery.data || providerEnablementMutationPending}
              onCheckedChange={(checked) =>
                void updateProviderEnablement(
                  setProviderListMembership(
                    settings.disabledProviders,
                    option.provider,
                    !Boolean(checked),
                  ),
                )
              }
              aria-label={t(enabled ? "settings:disableProvider" : "settings:enableProvider", {
                provider: option.title,
              })}
            />
          </>
        }
      />
    );
  };

  return (
    <div className="space-y-6">
      <SettingsSection title="settings:providerActivity">
        <SettingsRow
          id="setting-enabled-providers"
          title="settings:enabledProviders"
          description="settings:enableProvidersAcrossSynaraDisabledProvidersAreHiddenFrom"
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={refreshingProviders}
              onClick={() => void refreshProviders()}
            >
              {refreshingProviders ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {refreshingProviders ? t("settings:checkingSetup") : t("chat:refreshStatus")}
            </Button>
          }
          status={
            providerEnablementMutationPending
              ? "Saving provider activity"
              : `${enabledProviderCount} of ${PROVIDER_VISIBILITY_OPTIONS.length} enabled`
          }
          resetAction={
            disabledProviderSet.size > 0 && !providerEnablementMutationPending ? (
              <SettingResetButton
                label={t("settings:enabledProviders2")}
                onClick={() => void updateProviderEnablement([...defaults.disabledProviders])}
              />
            ) : null
          }
        >
          {enabledProviderCount > 0 ? (
            <div
              className={cn(
                "mt-4",
                SETTINGS_INSET_LIST_CLASS_NAME,
                SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
              )}
            >
              {enabledProviderOptions.map(renderProviderActivityRow)}
            </div>
          ) : (
            <p className="mt-4 text-ui text-muted-foreground">
              {t("settings:noProvidersEnabledOpenDisabledProvidersBelowToEnable")}
            </p>
          )}
          {disabledProviderOptions.length > 0 ? (
            <Collapsible
              open={disabledProvidersOpen}
              onOpenChange={setDisabledProvidersOpen}
              className="mt-3"
            >
              <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left text-ui text-muted-foreground">
                <DisclosureChevron open={disabledProvidersOpen} className="size-4 shrink-0" />
                <span>
                  {t("settings:disabledProviders")}
                  {disabledProviderOptions.length})
                </span>
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div
                  className={cn(
                    SETTINGS_INSET_LIST_CLASS_NAME,
                    SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
                  )}
                >
                  {disabledProviderOptions.map(renderProviderActivityRow)}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="settings:providers_providerPicker">
        <SettingsRow
          id="setting-available-clis"
          title="settings:availableCLIs"
          description="settings:showOrHideInstalledProvidersInThePickerAnd2"
          status={
            serverConfigQuery.isPending || hasPendingProviderStatuses
              ? "Checking installed CLIs"
              : availableProviderCount === 0
                ? "No CLIs detected"
                : visibleAvailableProviderCount < availableProviderCount
                  ? `${visibleAvailableProviderCount} of ${availableProviderCount} installed shown`
                  : isProviderOrderDirty
                    ? `${availableProviderCount} installed · custom order`
                    : `${availableProviderCount} installed`
          }
          resetAction={
            hiddenProviderCount > 0 || isProviderOrderDirty ? (
              <SettingResetButton
                label={t("settings:providerPicker")}
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
            onDragEnd={handleProviderOrderDragEnd}
          >
            <SortableContext
              items={enabledProviderOptions.map((option) => option.provider)}
              strategy={verticalListSortingStrategy}
            >
              <div className="mt-4 space-y-2">
                {enabledProviderOptions.map((option) => (
                  <SortableProviderVisibilityRow
                    key={option.provider}
                    option={option}
                    providerStatus={providerStatusByProvider.get(option.provider)}
                    statusReconciled={providerStatusesReconciled}
                    isDisabled={disabledProviderSet.has(option.provider)}
                    isHidden={hiddenProviderSet.has(option.provider)}
                    onHiddenChange={(hidden) =>
                      updateSettings({
                        hiddenProviders: setProviderListMembership(
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

      <SettingsSection title="settings:performance">
        <SettingsRow
          id="setting-keep-synara-responsive"
          title="settings:keepSynaraResponsive"
          description="settings:giveAgentProcessesAndTheirCommandsAModeratelyLower"
          status="Applies to newly launched agent processes. Restart existing sessions to apply consistently."
          resetAction={
            settings.lowerProviderProcessPriority !== defaults.lowerProviderProcessPriority ? (
              <SettingResetButton
                label={t("settings:keepSynaraResponsive")}
                onClick={() =>
                  updateSettings({
                    lowerProviderProcessPriority: defaults.lowerProviderProcessPriority,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.lowerProviderProcessPriority}
              onCheckedChange={(checked) =>
                updateSettings({ lowerProviderProcessPriority: Boolean(checked) })
              }
              aria-label={t("settings:keepSynaraResponsive")}
            />
          }
        />
      </SettingsSection>

      <div id={SETTINGS_TARGETS.providerUpdates}>
        <SettingsSection title="settings:providerUpdates_updates">
          <SettingsRow
            id="setting-automatic-cli-update-checks"
            title="settings:providerUpdates_automaticCliUpdateChecks"
            description="settings:checkCodexClaudeAndOtherProviderCLIsForNewer"
            resetAction={
              settings.enableProviderUpdateChecks !== defaults.enableProviderUpdateChecks ? (
                <SettingResetButton
                  label={t("settings:cLIUpdateChecks")}
                  onClick={() =>
                    updateSettings({
                      enableProviderUpdateChecks: defaults.enableProviderUpdateChecks,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.enableProviderUpdateChecks}
                onCheckedChange={(checked) =>
                  updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
                }
                aria-label={t("settings:providerUpdates_automaticCliUpdateChecks")}
              />
            }
          />

          <SettingsRow
            id="setting-provider-updates"
            title="settings:providerUpdates_providerUpdates"
            description="settings:reviewInstalledProviderToolsThatSynaraCanSafelyUpdate"
            status={
              !settings.enableProviderUpdateChecks
                ? "Automatic checks off"
                : outdatedProviderCount > 0
                  ? `${outdatedProviderCount} ${pluralize(outdatedProviderCount, "update")} available`
                  : "No provider updates detected"
            }
          >
            {settings.enableProviderUpdateChecks && outdatedProviderStatuses.length > 0 ? (
              <div
                className={cn(
                  "mt-4",
                  SETTINGS_INSET_LIST_CLASS_NAME,
                  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
                )}
              >
                {outdatedProviderStatuses.map((providerStatus) => {
                  const instanceId = providerStatusInstanceKey(providerStatus);
                  const updateActive =
                    isProviderUpdateActive(providerStatus) || updatingProviders.has(instanceId);
                  const updateLabel = providerUpdateStatusLabel(providerStatus);
                  return (
                    <SettingsListRow
                      key={instanceId}
                      title={providerStatusDisplayName(providerStatus)}
                      description={updateLabel || undefined}
                      actions={
                        providerStatus.versionAdvisory?.canUpdate ? (
                          <ProviderUpdateAction
                            providerStatus={providerStatus}
                            active={updateActive}
                            disabled={updateActive}
                            onUpdate={(provider) => void runProviderUpdate(provider)}
                          />
                        ) : (
                          <span className="text-ui-sm text-muted-foreground">
                            {t("settings:providerUpdates_manualUpdate")}
                          </span>
                        )
                      }
                    />
                  );
                })}
              </div>
            ) : null}
          </SettingsRow>
        </SettingsSection>
      </div>

      <div id={SETTINGS_TARGETS.providerInstalls}>
        <SettingsSection title="settings:providers_providerTools">
          <SettingsRow
            id="setting-installed-clis"
            title="settings:providers_installedClis"
            description="settings:providers_installedClisDescription"
            status={
              !settings.enableProviderUpdateChecks
                ? "Automatic checks off"
                : outdatedProviderCount > 0
                  ? `${outdatedProviderCount} ${pluralize(outdatedProviderCount, "update")} available`
                  : "No provider updates detected"
            }
            resetAction={
              installSettingsDirty ? (
                <SettingResetButton
                  label={t("settings:providerTools")}
                  onClick={() => {
                    updateSettings(createProviderInstallResetPatch(defaults));
                    setOpenInstallProviders(createClosedProviderInstallDisclosureState());
                  }}
                />
              ) : null
            }
          >
            <div className="mt-4">
              <div className={SETTINGS_INSET_LIST_CLASS_NAME}>
                {VISIBLE_PROVIDER_INSTALL_SETTINGS.filter(
                  (config) => !disabledProviderSet.has(config.provider),
                ).map((config) => (
                  <ProviderToolRow
                    key={config.provider}
                    config={config}
                    open={openInstallProviders[config.provider]}
                    settings={settings}
                    defaults={defaults}
                    hiddenProviderSet={hiddenProviderSet}
                    serverSettings={providerUpdateServerSettings}
                    providerStatus={providerStatusByProvider.get(config.provider)}
                    providerStatusByInstance={providerStatusByInstance}
                    updatingProviders={updatingProviders}
                    onOpenChange={(open) =>
                      setOpenInstallProviders((existing) => ({
                        ...existing,
                        [config.provider]: open,
                      }))
                    }
                    onUpdate={(provider) => void runProviderUpdate(provider)}
                    updateSettings={updateSettings}
                    updateSettingsAndWait={updateSettingsAndWait}
                  />
                ))}
              </div>
            </div>
          </SettingsRow>
        </SettingsSection>
      </div>
    </div>
  );
}
