// FILE: _chat.settings.tsx
// Purpose: Render the dedicated settings experience with its own section sidebar and grouped panels.
// Layer: Route screen
// Exports: Settings route component for `/settings`

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderStatus,
  type ThreadId,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
} from "@t3tools/contracts";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { pluralize } from "@t3tools/shared/text";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import i18n from "~/i18n";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  type AppSettings,
  DEFAULT_UI_DENSITY,
  type UiDensity,
  MAX_CHAT_FONT_SIZE_PX,
  MAX_TERMINAL_FONT_SIZE_PX,
  getCustomModelsForProvider,
  getGitTextGenerationModelOptions,
  MAX_CUSTOM_MODEL_LENGTH,
  MIN_CHAT_FONT_SIZE_PX,
  MIN_TERMINAL_FONT_SIZE_PX,
  MODEL_PROVIDER_SETTINGS,
  normalizeChatFontSizePx,
  normalizeTerminalFontFamily,
  normalizeTerminalFontSizePx,
  patchCustomModels,
  TERMINAL_FONT_FAMILY_SUGGESTIONS,
  useAppSettings,
} from "../appSettings";
import { APP_VERSION } from "../branding";
import { useDesktopTopBarTrafficLightGutterClassName } from "../hooks/useDesktopTopBarGutter";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { ProviderOptionLabel } from "../components/ProviderIcon";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../components/ui/autocomplete";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import {
  SettingResetButton,
  SettingsSegmentedControl,
  SettingsSelectControl,
} from "../components/settings/SettingControls";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { ThemePackEditor } from "../components/ThemePackEditor";
import { DebouncedSettingTextInput } from "../components/settings/DebouncedSettingTextInput";
import {
  SettingsCard,
  SettingsListRow,
  SettingsRow,
  SettingsSection,
  SettingsSelectPopup,
} from "../components/settings/SettingsPanelPrimitives";
import { ProviderUsageSettingsPanel } from "../components/settings/ProviderUsageSettingsPanel";
import { ProfileSettingsPanel } from "../components/settings/ProfileSettingsPanel";
import { KeyboardShortcutsSettingsPanel } from "../components/settings/KeyboardShortcutsSettingsPanel";
import { SkillsSettingsPanel } from "../components/settings/SkillsSettingsPanel";
import {
  CHAT_CONTENT_CARD_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "../components/chat/composerPickerStyles";
import {
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "../components/chat/chatHeaderControls";
import { SidebarHeaderNavigationControls } from "../components/SidebarHeaderNavigationControls";
import { RouteInsetSurface } from "../components/RouteInsetSurface";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { isUiDensity } from "../lib/appDensity";
import { CentralIcon } from "../lib/central-icons";
import { gitRemoveWorktreeMutationOptions } from "../lib/gitReactQuery";
import {
  deleteArchivedThreadFromClient,
  deleteArchivedThreadsFromClient,
} from "../lib/archivedThreadDelete";
import {
  ArchiveIcon,
  ChevronDownIcon,
  DeviceLaptopIcon,
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MoonIcon,
  PlusIcon,
  RotateCcwIcon,
  SunIcon,
  XIcon,
} from "../lib/icons";
import {
  serverConfigQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
  serverWorktreesQueryOptions,
} from "../lib/serverReactQuery";
import { cn, isMacPlatform } from "../lib/utils";
import { unarchiveThreadFromClient } from "../lib/threadArchive";
import { resolveProviderDiscoveryCwd } from "../lib/providerDiscovery";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import {
  buildNotificationSettingsSupportText,
  readBrowserNotificationPermissionState,
  requestBrowserNotificationPermission,
} from "../notifications/taskCompletion";
import {
  normalizeSettingsSection,
  SETTINGS_NAV_ITEMS,
  SETTINGS_TARGETS,
} from "../settingsNavigation";
import {
  SETTINGS_CARD_ROW_CLASS_NAME,
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
  SETTINGS_EMPTY_STATE_CLASS_NAME,
  SETTINGS_INSET_LIST_CLASS_NAME,
  SETTINGS_PAGE_BACKGROUND_CLASS_NAME,
  SETTINGS_PANEL_SECTION_CLASS_NAME,
  SETTINGS_RADIUS_CLASS_NAME,
  SETTINGS_SECTION_LABEL_CLASS_NAME,
} from "../settingsPanelStyles";
import { useStore } from "../store";
import ReleaseHistoryDialog from "../components/ReleaseHistoryDialog";
import { createAllThreadsMessagelessSelector, createThreadShellsSelector } from "../storeSelectors";
import { formatRelativeTime } from "../lib/relativeTime";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { sameProviderOrder } from "../providerOrdering";
import {
  getVisibleProviderUpdateStatuses,
  shouldShowProviderUpdateStatus,
} from "../providerUpdates";

// ── Settings taxonomy ──────────────────────────────────────────────────────

const UI_DENSITY_OPTIONS = [
  {
    value: "compact",
    label: "Compact",
    description: "Tighter spacing in the sidebar, composer, and settings rows.",
  },
  {
    value: "comfortable",
    label: "Comfortable",
    description: "Balanced spacing for everyday use.",
  },
  {
    value: "spacious",
    label: "Spacious",
    description: "More breathing room across the main workspace surfaces.",
  },
] as const satisfies ReadonlyArray<{
  value: UiDensity;
  label: string;
  description: string;
}>;

const THEME_OPTIONS = [
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
    icon: <SunIcon />,
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
    icon: <MoonIcon />,
  },
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
    icon: <DeviceLaptopIcon />,
  },
] as const;

const PROVIDER_SELECT_OPTIONS = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "opencode",
  "kilo",
  "pi",
] as const satisfies readonly ProviderKind[];

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const SIDEBAR_PROJECT_SORT_ORDER_KEYS = {
  updated_at: "settings.general.projectOrderRecentlyActive",
  created_at: "settings.general.projectOrderRecentlyAdded",
  manual: "settings.general.projectOrderManual",
} as const;

const SIDEBAR_THREAD_SORT_ORDER_KEYS = {
  updated_at: "settings.general.threadOrderRecentlyActive",
  created_at: "settings.general.threadOrderNewestFirst",
} as const;

type InstallBinarySettingsKey =
  | "claudeBinaryPath"
  | "codexBinaryPath"
  | "cursorBinaryPath"
  | "geminiBinaryPath"
  | "grokBinaryPath"
  | "kiloBinaryPath"
  | "openCodeBinaryPath"
  | "piBinaryPath";
type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  docs: ReadonlyArray<{
    label: string;
    href: string;
  }>;
  binaryPathKey: InstallBinarySettingsKey;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
  apiEndpointKey?: "cursorApiEndpoint";
  apiEndpointPlaceholder?: string;
  apiEndpointDescription?: ReactNode;
  serverUrlKey?: "kiloServerUrl" | "openCodeServerUrl";
  serverUrlPlaceholder?: string;
  serverUrlDescription?: ReactNode;
  serverPasswordKey?: "kiloServerPassword" | "openCodeServerPassword";
  serverPasswordPlaceholder?: string;
  serverPasswordDescription?: ReactNode;
  experimentalWebSocketsKey?: "openCodeExperimentalWebSockets";
  experimentalWebSocketsDescription?: ReactNode;
  agentDirKey?: "piAgentDir";
  agentDirPlaceholder?: string;
  agentDirDescription?: ReactNode;
};

const PROVIDER_VISIBILITY_OPTIONS: ReadonlyArray<{ provider: ProviderKind; title: string }> = [
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
function setProviderHidden(
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

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        `flex items-center justify-between gap-3 ${SETTINGS_RADIUS_CLASS_NAME} border border-[color:var(--color-border)] bg-transparent px-3 py-2.5`,
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className={cn(
            "inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-foreground active:cursor-grabbing",
            SETTINGS_RADIUS_CLASS_NAME,
          )}
          aria-label={t("settings.providers.reorderProvider", { title: props.option.title })}
          {...attributes}
          {...listeners}
        >
          <CentralIcon name="dot-grid-2x3" className="size-4" />
        </button>
        <span className="min-w-0 text-sm text-foreground">{props.option.title}</span>
      </div>
      <Switch
        checked={!props.isHidden}
        onCheckedChange={(checked) => props.onHiddenChange(!Boolean(checked))}
        aria-label={t("settings.providers.showProvider", { title: props.option.title })}
      />
    </div>
  );
}

const INSTALL_PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    docs: [
      { label: "Install", href: "https://help.openai.com/en/articles/11096431" },
      { label: "Update", href: "https://help.openai.com/en/articles/11096431" },
      { label: "Config", href: "https://github.com/openai/codex/blob/main/docs/config.md" },
    ],
    binaryPathKey: "codexBinaryPath",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>codex</code> from your PATH.
      </>
    ),
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    docs: [
      { label: "Install", href: "https://code.claude.com/docs/en/installation" },
      { label: "Update", href: "https://code.claude.com/docs/en/installation#update-claude-code" },
      { label: "Config", href: "https://code.claude.com/docs/en/settings" },
    ],
    binaryPathKey: "claudeBinaryPath",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>claude</code> from your PATH.
      </>
    ),
  },
  {
    provider: "cursor",
    title: "Cursor",
    docs: [
      { label: "Install", href: "https://docs.cursor.com/en/cli/installation" },
      { label: "Update", href: "https://docs.cursor.com/en/cli/installation#updates" },
      { label: "Config", href: "https://docs.cursor.com/en/cli/overview" },
    ],
    binaryPathKey: "cursorBinaryPath",
    binaryPlaceholder: "Cursor Agent or Cursor CLI path",
    binaryDescription: (
      <>
        Leave blank to use <code>cursor-agent</code> from your PATH. Cursor editor CLI paths are
        accepted too.
      </>
    ),
    apiEndpointKey: "cursorApiEndpoint",
    apiEndpointPlaceholder: "https://api2.cursor.sh",
    apiEndpointDescription: "Optional Cursor API endpoint override passed to `cursor-agent -e`.",
  },
  {
    provider: "gemini",
    title: "Gemini",
    docs: [
      { label: "Install", href: "https://google-gemini.github.io/gemini-cli/docs/get-started/" },
      { label: "Update", href: "https://github.com/google-gemini/gemini-cli" },
      {
        label: "Config",
        href: "https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html",
      },
    ],
    binaryPathKey: "geminiBinaryPath",
    binaryPlaceholder: "Gemini binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>gemini</code> from your PATH.
      </>
    ),
  },
  {
    provider: "grok",
    title: "Grok",
    docs: [
      { label: "Install", href: "https://docs.x.ai/build/overview" },
      { label: "Headless", href: "https://docs.x.ai/build/cli/headless-scripting" },
      { label: "Config", href: "https://docs.x.ai/build/overview" },
    ],
    binaryPathKey: "grokBinaryPath",
    binaryPlaceholder: "Grok binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>grok</code> from your PATH.
      </>
    ),
  },
  {
    provider: "kilo",
    title: "Kilo",
    docs: [
      { label: "Install", href: "https://kilo.ai/docs/cli" },
      { label: "Update", href: "https://kilo.ai/docs/cli" },
      { label: "Config", href: "https://kilo.ai/docs/cli#configuration" },
    ],
    binaryPathKey: "kiloBinaryPath",
    binaryPlaceholder: "Kilo binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>kilo</code> from your PATH.
      </>
    ),
    serverUrlKey: "kiloServerUrl",
    serverUrlPlaceholder: "http://127.0.0.1:4096",
    serverUrlDescription: "Optional existing Kilo server URL. Leave blank to spawn a local server.",
    serverPasswordKey: "kiloServerPassword",
    serverPasswordPlaceholder: "Kilo server password",
    serverPasswordDescription: "Optional password for an externally managed Kilo server.",
  },
  {
    provider: "opencode",
    title: "OpenCode",
    docs: [
      { label: "Install", href: "https://opencode.ai/docs/" },
      { label: "Update", href: "https://opencode.ai/docs/cli/" },
      { label: "Config", href: "https://opencode.ai/docs/config/" },
    ],
    binaryPathKey: "openCodeBinaryPath",
    binaryPlaceholder: "OpenCode binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>opencode</code> from your PATH.
      </>
    ),
    serverUrlKey: "openCodeServerUrl",
    serverUrlPlaceholder: "http://127.0.0.1:4096",
    serverUrlDescription:
      "Optional existing OpenCode server URL. Leave blank to spawn a local server.",
    serverPasswordKey: "openCodeServerPassword",
    serverPasswordPlaceholder: "OpenCode server password",
    serverPasswordDescription: "Optional password for an externally managed OpenCode server.",
    experimentalWebSocketsKey: "openCodeExperimentalWebSockets",
    experimentalWebSocketsDescription:
      "Use Opencode's experimental OpenAI response WebSocket transport for managed local servers.",
  },
  {
    provider: "pi",
    title: "Pi",
    docs: [
      { label: "Install", href: "https://pi.dev/docs/latest" },
      { label: "Update", href: "https://pi.dev/docs/latest/settings" },
      { label: "Config", href: "https://pi.dev/docs/latest/settings" },
    ],
    binaryPathKey: "piBinaryPath",
    binaryPlaceholder: "Pi binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>pi</code> from your PATH.
      </>
    ),
    agentDirKey: "piAgentDir",
    agentDirPlaceholder: "Pi agent directory",
    agentDirDescription:
      "Optional custom Pi agent directory for auth, models, skills, and commands.",
  },
];

// ── Settings UI primitives ────────────────────────────────────────────────

// Shared settings controls live in ~/components/settings/SettingControls.

function isProviderSelectOption(value: string): value is ProviderKind {
  return PROVIDER_SELECT_OPTIONS.includes(value as ProviderKind);
}

function ProviderDocsLinks({
  docs,
  t,
}: {
  docs: InstallProviderSettings["docs"];
  t: (key: string, options?: any) => string;
}) {
  const docLabelKey = (label: string): string => {
    const map: Record<string, string> = {
      Install: "settings.providers.docInstall",
      Update: "settings.providers.docUpdate",
      Config: "settings.providers.docConfig",
      Headless: "settings.providers.docHeadless",
    };
    return map[label] ?? label;
  };
  return (
    <div className={cn(SETTINGS_INSET_LIST_CLASS_NAME, "px-3 py-2.5")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs font-medium text-foreground">
          {t("settings.providers.cliDocs")}
        </span>
        <div className="flex flex-wrap gap-2">
          {docs.map((doc) => (
            <a
              key={`${doc.label}:${doc.href}`}
              href={doc.href}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "inline-flex h-7 items-center gap-1.5 border border-[color:var(--color-border)] bg-transparent px-2.5 text-xs text-muted-foreground transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-foreground",
                SETTINGS_RADIUS_CLASS_NAME,
              )}
            >
              <span>{t(docLabelKey(doc.label))}</span>
              <ExternalLinkIcon className="size-3" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function normalizeManagedWorktreePath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function formatProviderVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function providerUpdateStatusLabel(
  provider: ServerProviderStatus,
  t: (key: string, options?: any) => string,
): string | null {
  const state = provider.updateState?.status;
  if (state === "queued") {
    return t("settings.providerUpdates.queued");
  }
  if (state === "running") {
    return t("settings.providerUpdates.updating");
  }
  if (state === "succeeded") {
    return t("settings.providerUpdates.succeeded");
  }
  if (state === "failed") {
    return t("settings.providerUpdates.failed");
  }
  if (state === "unchanged") {
    return t("settings.providerUpdates.unchanged");
  }
  const advisory = provider.versionAdvisory;
  if (advisory?.status === "behind_latest" && advisory.latestVersion) {
    const currentVersion = formatProviderVersion(advisory.currentVersion);
    const latestVersion = formatProviderVersion(advisory.latestVersion);
    return currentVersion
      ? t("settings.providerUpdates.versionRange", {
          current: currentVersion,
          latest: latestVersion,
        })
      : t("settings.providerUpdates.latestOnly", { latest: latestVersion });
  }
  const currentVersion = formatProviderVersion(provider.version);
  return currentVersion ? t("settings.providerUpdates.current", { version: currentVersion }) : null;
}

function providerUpdateFailureMessage(
  provider: ServerProviderStatus | undefined,
  t: (key: string, options?: any) => string,
): string | null {
  const state = provider?.updateState;
  if (!state || (state.status !== "failed" && state.status !== "unchanged")) {
    return null;
  }
  return (
    state.output?.trim() || state.message || t("settings.providerUpdates.updateDidNotComplete")
  );
}

// Keys of AppSettings whose value is a plain boolean — the only ones that can be
// driven by the shared on/off toggle row below.
type BooleanSettingKey = {
  [Key in keyof AppSettings]-?: AppSettings[Key] extends boolean ? Key : never;
}[keyof AppSettings];

// ── Route screen ───────────────────────────────────────────────────────────

// Scroll a deep-linked settings section into view when it becomes the active `?target=…`.
// `retriggerKey` lets a panel re-attempt after late-loading data mounts the target element.
function useSettingsTargetScroll(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  retriggerKey?: unknown,
): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, ref, retriggerKey]);
}

function SettingsRouteView() {
  const { t } = useTranslation();
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const activeSection = normalizeSettingsSection(routeSearch.section);
  const settingsTarget = typeof routeSearch.target === "string" ? routeSearch.target : null;
  const activeSectionItem = SETTINGS_NAV_ITEMS.find((item) => item.id === activeSection)!;

  const { isDefaultActiveTheme, resetAllThemes, resolvedTheme, theme, setTheme } = useTheme();
  const { settings, defaults, updateSettings, resetSettings } = useAppSettings();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const serverWorktreesQuery = useQuery(serverWorktreesQueryOptions());
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const removeDeletedThreadFromClientState = useStore(
    (store) => store.removeDeletedThreadFromClientState,
  );
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  // Shell-level subscription on purpose: the full-thread selector invalidates on every
  // streaming message/activity tick, which would re-render this whole route while a
  // turn is running. Settings only needs thread metadata (and message emptiness below).
  const threadShells = useStore(useMemo(() => createThreadShellsSelector(), []));
  const allThreadsMessageless = useStore(useMemo(() => createAllThreadsMessagelessSelector(), []));
  const projects = useStore((store) => store.projects);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const archivedThreads = useMemo(
    () => threadShells.filter((thread) => thread.archivedAt != null),
    [threadShells],
  );
  const shouldOfferRecoveryTools = useMemo(() => {
    if (!threadsHydrated || projects.length === 0) {
      return false;
    }
    return threadShells.length === 0 || allThreadsMessageless;
  }, [allThreadsMessageless, projects.length, threadShells.length, threadsHydrated]);

  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [isRepairingLocalState, setIsRepairingLocalState] = useState(false);
  const [showRecoveryTools, setShowRecoveryTools] = useState(false);
  const [releaseHistoryOpen, setReleaseHistoryOpen] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const providerUpdatesRef = useRef<HTMLDivElement | null>(null);
  const providerInstallsRef = useRef<HTMLDivElement | null>(null);
  const environmentPanelRef = useRef<HTMLDivElement | null>(null);
  const [openInstallProviders, setOpenInstallProviders] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(settings.codexBinaryPath || settings.codexHomePath),
    claudeAgent: Boolean(settings.claudeBinaryPath),
    cursor: Boolean(settings.cursorBinaryPath || settings.cursorApiEndpoint),
    gemini: Boolean(settings.geminiBinaryPath),
    grok: Boolean(settings.grokBinaryPath),
    kilo: Boolean(settings.kiloBinaryPath || settings.kiloServerUrl || settings.kiloServerPassword),
    opencode: Boolean(
      settings.openCodeBinaryPath ||
      settings.openCodeExperimentalWebSockets ||
      settings.openCodeServerUrl ||
      settings.openCodeServerPassword,
    ),
    pi: Boolean(settings.piBinaryPath || settings.piAgentDir),
  });
  const [updatingProviders, setUpdatingProviders] = useState<ReadonlySet<ProviderKind>>(
    () => new Set(),
  );
  const [selectedCustomModelProvider, setSelectedCustomModelProvider] =
    useState<ProviderKind>("codex");
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
    cursor: "",
    gemini: "",
    grok: "",
    kilo: "",
    opencode: "",
    pi: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [showAllCustomModels, setShowAllCustomModels] = useState(false);
  const [browserNotificationPermission, setBrowserNotificationPermission] = useState(
    readBrowserNotificationPermissionState(),
  );
  const shouldShowFontSmoothing = isMacPlatform(
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
  const visibleTerminalFontFamilySuggestions = useMemo(() => {
    const query = settings.terminalFontFamily.trim().toLowerCase();
    if (!query) return TERMINAL_FONT_FAMILY_SUGGESTIONS;
    return TERMINAL_FONT_FAMILY_SUGGESTIONS.filter((suggestion) =>
      suggestion.toLowerCase().includes(query),
    );
  }, [settings.terminalFontFamily]);

  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const hiddenProviderCount = hiddenProviderSet.size;
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
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 4,
      },
    }),
  );
  const isProviderOrderDirty = !sameProviderOrder(settings.providerOrder, defaults.providerOrder);
  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const claudeBinaryPath = settings.claudeBinaryPath;
  const cursorBinaryPath = settings.cursorBinaryPath;
  const cursorApiEndpoint = settings.cursorApiEndpoint;
  const geminiBinaryPath = settings.geminiBinaryPath;
  const grokBinaryPath = settings.grokBinaryPath;
  const kiloBinaryPath = settings.kiloBinaryPath;
  const kiloServerUrl = settings.kiloServerUrl;
  const kiloServerPassword = settings.kiloServerPassword;
  const openCodeBinaryPath = settings.openCodeBinaryPath;
  const openCodeExperimentalWebSockets = settings.openCodeExperimentalWebSockets;
  const openCodeServerUrl = settings.openCodeServerUrl;
  const openCodeServerPassword = settings.openCodeServerPassword;
  const piBinaryPath = settings.piBinaryPath;
  const piAgentDir = settings.piAgentDir;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = serverConfigQuery.data?.availableEditors;
  const providerStatusByProvider = useMemo(
    () =>
      new Map((serverConfigQuery.data?.providers ?? []).map((status) => [status.provider, status])),
    [serverConfigQuery.data?.providers],
  );
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
      }),
    [providerUpdateServerSettings, serverConfigQuery.data?.providers, settings.hiddenProviders],
  );
  const outdatedProviderCount = outdatedProviderStatuses.length;
  useSettingsTargetScroll(
    activeSection === "providers" && settingsTarget === SETTINGS_TARGETS.providerUpdates,
    providerUpdatesRef,
    serverConfigQuery.data?.providers,
  );

  // Deep-link target for the chat Environment panel's gear button (see EnvironmentPanel).
  useSettingsTargetScroll(
    activeSection === "general" && settingsTarget === SETTINGS_TARGETS.environmentPanel,
    environmentPanelRef,
  );

  // Sidebar search deep-links to an individual row via its `settingRowAnchorId`. The active
  // panel renders synchronously with this section change, so scroll once the row has mounted.
  useEffect(() => {
    if (!settingsTarget || !settingsTarget.startsWith("setting-")) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(settingsTarget)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, settingsTarget]);
  const managedWorktrees = serverWorktreesQuery.data?.worktrees;
  const worktreesByWorkspaceRoot = useMemo(() => {
    type WorktreeGroup = {
      workspaceRoot: string;
      worktrees: Array<{
        path: string;
        linkedThreads: typeof threadShells;
      }>;
    };
    // Map keeps grouping O(worktrees) instead of the previous O(worktrees²) `groups.find`,
    // while `groups` preserves the original first-seen workspace-root order.
    const groups: WorktreeGroup[] = [];
    const groupByRoot = new Map<string, WorktreeGroup>();
    for (const worktree of managedWorktrees ?? []) {
      const linkedThreads = threadShells.filter((thread) => {
        const candidatePaths = [
          normalizeManagedWorktreePath(thread.worktreePath),
          normalizeManagedWorktreePath(thread.associatedWorktreePath),
        ];
        return candidatePaths.includes(worktree.path);
      });
      const nextWorktree = { path: worktree.path, linkedThreads };
      const existingGroup = groupByRoot.get(worktree.workspaceRoot);
      if (existingGroup) {
        existingGroup.worktrees.push(nextWorktree);
      } else {
        const group: WorktreeGroup = {
          workspaceRoot: worktree.workspaceRoot,
          worktrees: [nextWorktree],
        };
        groups.push(group);
        groupByRoot.set(worktree.workspaceRoot, group);
      }
    }
    return groups;
  }, [managedWorktrees, threadShells]);

  // Builds provider model-option arrays; only the Models panel reads it. Memoize on the
  // narrow inputs the helper actually uses (destructured so exhaustive-deps stays exact) so
  // typing in any other settings field — every keystroke re-renders this monolithic route —
  // doesn't rebuild these lists.
  const {
    customCodexModels,
    customKiloModels,
    customOpenCodeModels,
    textGenerationModel,
    textGenerationProvider,
  } = settings;
  const currentGitTextGenerationProvider = textGenerationProvider ?? "codex";
  const currentGitTextGenerationModel = textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
  const gitWritingModelHintByProvider = useMemo<Partial<Record<ProviderKind, string | null>>>(
    () => ({ [currentGitTextGenerationProvider]: currentGitTextGenerationModel }),
    [currentGitTextGenerationModel, currentGitTextGenerationProvider],
  );
  const providerModelDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: null,
    activeProjectCwd: null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const { modelOptionsByProvider: gitWritingCatalogOptionsByProvider } = useProviderModelCatalog({
    selectedProvider: currentGitTextGenerationProvider,
    discoveryEnabled: activeSection === "models",
    cwd: providerModelDiscoveryCwd,
    modelHintByProvider: gitWritingModelHintByProvider,
  });
  const gitTextGenerationModelOptions = useMemo(
    () =>
      getGitTextGenerationModelOptions(
        {
          customCodexModels,
          customKiloModels,
          customOpenCodeModels,
          textGenerationModel,
          textGenerationProvider,
        },
        {
          codex: gitWritingCatalogOptionsByProvider.codex,
          kilo: gitWritingCatalogOptionsByProvider.kilo,
          opencode: gitWritingCatalogOptionsByProvider.opencode,
        },
      ),
    [
      customCodexModels,
      customKiloModels,
      customOpenCodeModels,
      gitWritingCatalogOptionsByProvider.codex,
      gitWritingCatalogOptionsByProvider.kilo,
      gitWritingCatalogOptionsByProvider.opencode,
      textGenerationModel,
      textGenerationProvider,
    ],
  );
  const currentGitTextGenerationValue = `${currentGitTextGenerationProvider}:${currentGitTextGenerationModel}`;
  const defaultGitTextGenerationProvider = defaults.textGenerationProvider ?? "codex";
  const defaultGitTextGenerationModel =
    defaults.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
  const isGitTextGenerationModelDirty =
    currentGitTextGenerationProvider !== defaultGitTextGenerationProvider ||
    currentGitTextGenerationModel !== defaultGitTextGenerationModel;
  const selectedGitTextGenerationModelLabel =
    gitTextGenerationModelOptions.find(
      (option) =>
        option.provider === currentGitTextGenerationProvider &&
        option.slug === currentGitTextGenerationModel,
    )?.name ?? currentGitTextGenerationModel;
  const selectedCustomModelProviderSettings = MODEL_PROVIDER_SETTINGS.find(
    (providerSettings) => providerSettings.provider === selectedCustomModelProvider,
  )!;
  const selectedCustomModelInput = customModelInputByProvider[selectedCustomModelProvider];
  const selectedCustomModelError = customModelErrorByProvider[selectedCustomModelProvider] ?? null;
  const totalCustomModels =
    settings.customCodexModels.length +
    settings.customClaudeModels.length +
    settings.customCursorModels.length +
    settings.customGeminiModels.length +
    settings.customGrokModels.length +
    settings.customKiloModels.length +
    settings.customOpenCodeModels.length +
    settings.customPiModels.length;
  const savedCustomModelRows = useMemo(
    () =>
      MODEL_PROVIDER_SETTINGS.flatMap((providerSettings) =>
        getCustomModelsForProvider(settings, providerSettings.provider).map((slug) => ({
          key: `${providerSettings.provider}:${slug}`,
          provider: providerSettings.provider,
          providerTitle: providerSettings.title,
          slug,
        })),
      ),
    [settings],
  );
  const visibleCustomModelRows = showAllCustomModels
    ? savedCustomModelRows
    : savedCustomModelRows.slice(0, 5);
  const isInstallSettingsDirty =
    settings.claudeBinaryPath !== defaults.claudeBinaryPath ||
    settings.cursorBinaryPath !== defaults.cursorBinaryPath ||
    settings.cursorApiEndpoint !== defaults.cursorApiEndpoint ||
    settings.geminiBinaryPath !== defaults.geminiBinaryPath ||
    settings.grokBinaryPath !== defaults.grokBinaryPath ||
    settings.kiloBinaryPath !== defaults.kiloBinaryPath ||
    settings.kiloServerUrl !== defaults.kiloServerUrl ||
    settings.kiloServerPassword !== defaults.kiloServerPassword ||
    settings.codexBinaryPath !== defaults.codexBinaryPath ||
    settings.codexHomePath !== defaults.codexHomePath ||
    settings.openCodeBinaryPath !== defaults.openCodeBinaryPath ||
    settings.openCodeExperimentalWebSockets !== defaults.openCodeExperimentalWebSockets ||
    settings.openCodeServerUrl !== defaults.openCodeServerUrl ||
    settings.openCodeServerPassword !== defaults.openCodeServerPassword ||
    settings.piBinaryPath !== defaults.piBinaryPath ||
    settings.piAgentDir !== defaults.piAgentDir;
  const changedSettingLabels = [
    ...(theme !== "system" ? [t("settings.advanced.changed.theme")] : []),
    ...(!isDefaultActiveTheme
      ? [
          t("settings.advanced.changed.themePack", {
            variant:
              resolvedTheme === "dark"
                ? t("settings.advanced.changed.themePackDark")
                : t("settings.advanced.changed.themePackLight"),
          }),
        ]
      : []),
    ...(settings.defaultProvider !== defaults.defaultProvider
      ? [t("settings.advanced.changed.defaultProvider")]
      : []),
    ...(settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode
      ? [t("settings.advanced.changed.newThreadMode")]
      : []),
    ...(settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder
      ? [t("settings.advanced.changed.projectSortOrder")]
      : []),
    ...(settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder
      ? [t("settings.advanced.changed.threadSortOrder")]
      : []),
    ...(settings.showChatsSection !== defaults.showChatsSection
      ? [t("settings.advanced.changed.chatsSection")]
      : []),
    ...(settings.showWorkspaceSection !== defaults.showWorkspaceSection
      ? [t("settings.advanced.changed.workspaceSection")]
      : []),
    ...(settings.uiDensity !== defaults.uiDensity
      ? [t("settings.advanced.changed.uiDensity")]
      : []),
    ...(settings.chatFontSizePx !== defaults.chatFontSizePx
      ? [t("settings.advanced.changed.baseFontSize")]
      : []),
    ...(settings.terminalFontSizePx !== defaults.terminalFontSizePx
      ? [t("settings.advanced.changed.terminalFontSize")]
      : []),
    ...(settings.terminalFontFamily !== defaults.terminalFontFamily
      ? [t("settings.advanced.changed.terminalFont")]
      : []),
    ...(shouldShowFontSmoothing &&
    settings.enableNativeFontSmoothing !== defaults.enableNativeFontSmoothing
      ? [t("settings.advanced.changed.fontSmoothing")]
      : []),
    ...(settings.timestampFormat !== defaults.timestampFormat
      ? [t("settings.advanced.changed.timeFormat")]
      : []),
    ...(settings.enableTaskCompletionToasts !== defaults.enableTaskCompletionToasts
      ? [t("settings.advanced.changed.activityToasts")]
      : []),
    ...(settings.enableSystemTaskCompletionNotifications !==
    defaults.enableSystemTaskCompletionNotifications
      ? [t("settings.advanced.changed.desktopNotifications")]
      : []),
    ...(settings.enableAssistantStreaming !== defaults.enableAssistantStreaming
      ? [t("settings.advanced.changed.assistantOutput")]
      : []),
    ...(settings.enableProviderUpdateChecks !== defaults.enableProviderUpdateChecks
      ? [t("settings.advanced.changed.providerUpdateChecks")]
      : []),
    ...(settings.diffWordWrap !== defaults.diffWordWrap
      ? [t("settings.advanced.changed.diffLineWrapping")]
      : []),
    ...(settings.confirmThreadDelete !== defaults.confirmThreadDelete
      ? [t("settings.advanced.changed.deleteConfirmation")]
      : []),
    ...(settings.confirmThreadArchive !== defaults.confirmThreadArchive
      ? [t("settings.advanced.changed.archiveConfirmation")]
      : []),
    ...(settings.confirmTerminalTabClose !== defaults.confirmTerminalTabClose
      ? [t("settings.advanced.changed.terminalCloseConfirmation")]
      : []),
    ...(isGitTextGenerationModelDirty ? [t("settings.advanced.changed.gitWritingModel")] : []),
    ...(settings.customCodexModels.length > 0 ||
    settings.customClaudeModels.length > 0 ||
    settings.customCursorModels.length > 0 ||
    settings.customGeminiModels.length > 0 ||
    settings.customGrokModels.length > 0 ||
    settings.customKiloModels.length > 0 ||
    settings.customOpenCodeModels.length > 0 ||
    settings.customPiModels.length > 0
      ? [t("settings.advanced.changed.customModels")]
      : []),
    ...(isInstallSettingsDirty ? [t("settings.advanced.changed.providerInstalls")] : []),
    ...(hiddenProviderCount > 0 ? [t("settings.advanced.changed.providerVisibility")] : []),
    ...(isProviderOrderDirty ? [t("settings.advanced.changed.providerOrder")] : []),
  ];

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError(t("settings.advanced.noEditorFound"));
      setIsOpeningKeybindings(false);
      return;
    }
    void api.shell
      .openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : t("settings.advanced.unableToOpenKeybindings"),
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);

  useEffect(() => {
    setBrowserNotificationPermission(readBrowserNotificationPermissionState());
  }, []);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: t("settings.models.enterModelSlug"),
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: t("settings.models.modelAlreadyBuiltIn"),
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: t("settings.models.modelSlugTooLong", { max: MAX_CUSTOM_MODEL_LENGTH }),
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: t("settings.models.modelAlreadySaved"),
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const handleProviderOrderDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const fromIndex = settings.providerOrder.indexOf(active.id as ProviderKind);
      const toIndex = settings.providerOrder.indexOf(over.id as ProviderKind);
      if (fromIndex < 0 || toIndex < 0) {
        return;
      }
      updateSettings({
        providerOrder: arrayMove([...settings.providerOrder], fromIndex, toIndex),
      });
    },
    [settings.providerOrder, updateSettings],
  );

  const runProviderUpdate = useCallback(
    async (provider: ProviderKind) => {
      if (updatingProviders.has(provider)) {
        return;
      }
      setUpdatingProviders((current) => new Set(current).add(provider));
      try {
        const result = await ensureNativeApi().server.updateProvider({ provider });
        const refreshedProvider = result.providers.find((status) => status.provider === provider);
        const failureMessage = providerUpdateFailureMessage(refreshedProvider, t);
        if (failureMessage) {
          const manualCommand = refreshedProvider?.versionAdvisory?.updateCommand?.trim();
          toastManager.add({
            type: "error",
            title: t("settings.providerUpdates.couldNotUpdate", {
              provider: PROVIDER_DISPLAY_NAMES[provider],
            }),
            description: manualCommand
              ? t("settings.providerUpdates.updateManualCommand")
              : failureMessage,
            ...(manualCommand ? { data: { copyText: manualCommand } } : {}),
          });
          return;
        }
        toastManager.add({
          type: "success",
          title: t("settings.providerUpdates.updateFinished", {
            provider: PROVIDER_DISPLAY_NAMES[provider],
          }),
          description: t("settings.providerUpdates.newSessionsUseRefreshed"),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings.providerUpdates.couldNotUpdate", {
            provider: PROVIDER_DISPLAY_NAMES[provider],
          }),
          description:
            error instanceof Error
              ? error.message
              : t("settings.providerUpdates.updateFailedGeneric"),
        });
      } finally {
        await queryClient
          .invalidateQueries({ queryKey: serverQueryKeys.config() })
          .catch(() => undefined);
        setUpdatingProviders((current) => {
          const next = new Set(current);
          next.delete(provider);
          return next;
        });
      }
    },
    [queryClient, updatingProviders],
  );

  async function restoreDefaults() {
    if (changedSettingLabels.length === 0) return;

    const api = readNativeApi();
    const confirmed = await (api ?? ensureNativeApi()).dialogs.confirm(
      [
        t("settings.advanced.restoreDefaults"),
        t("settings.advanced.restoreDefaultsDescription", {
          labels: changedSettingLabels.join(", "),
        }),
      ].join("\n"),
    );
    if (!confirmed) return;

    setTheme("system");
    resetAllThemes();
    resetSettings();
    setOpenInstallProviders({
      codex: false,
      claudeAgent: false,
      cursor: false,
      gemini: false,
      grok: false,
      kilo: false,
      opencode: false,
      pi: false,
    });
    setSelectedCustomModelProvider("codex");
    setCustomModelInputByProvider({
      codex: "",
      claudeAgent: "",
      cursor: "",
      gemini: "",
      grok: "",
      kilo: "",
      opencode: "",
      pi: "",
    });
    setCustomModelErrorByProvider({});
    setShowAllCustomModels(false);
    setShowRecoveryTools(false);
    setOpenKeybindingsError(null);
  }

  async function setSystemNotificationsEnabled(nextEnabled: boolean) {
    if (!nextEnabled) {
      updateSettings({ enableSystemTaskCompletionNotifications: false });
      return;
    }

    if (isElectron) {
      updateSettings({ enableSystemTaskCompletionNotifications: true });
      return;
    }

    const permission = await requestBrowserNotificationPermission();
    setBrowserNotificationPermission(permission);

    if (permission === "granted") {
      updateSettings({ enableSystemTaskCompletionNotifications: true });
      return;
    }

    updateSettings({ enableSystemTaskCompletionNotifications: false });
    toastManager.add({
      type: permission === "denied" ? "warning" : "error",
      title: t("settings.notifications.desktopUnavailable"),
      description: buildNotificationSettingsSupportText(permission),
    });
  }

  async function sendTestNotification() {
    const title = t("settings.notifications.testNotificationTitle");
    const body = t("settings.notifications.testNotificationBody");

    if (window.desktopBridge) {
      const shown = await window.desktopBridge.notifications.show({ title, body, silent: false });
      toastManager.add({
        type: shown ? "success" : "warning",
        title: shown
          ? t("settings.notifications.testSent")
          : t("settings.notifications.notificationsUnavailable"),
        description: shown
          ? t("settings.notifications.testSentDesktopDescription")
          : t("settings.notifications.desktopNotSupported"),
      });
      return;
    }

    const permission = await requestBrowserNotificationPermission();
    setBrowserNotificationPermission(permission);
    if (permission !== "granted") {
      toastManager.add({
        type: permission === "denied" ? "warning" : "error",
        title: t("settings.notifications.desktopUnavailable"),
        description: buildNotificationSettingsSupportText(permission),
      });
      return;
    }

    const notification = new Notification(title, { body, tag: "synara:test-notification" });
    notification.addEventListener("click", () => {
      window.focus();
    });
    toastManager.add({
      type: "success",
      title: t("settings.notifications.testSent"),
      description: t("settings.notifications.testSentBrowserDescription"),
    });
  }

  // Rebuild the local project indexes after an older install leaves them out of sync.
  const repairLocalState = useCallback(async () => {
    if (isRepairingLocalState) {
      return;
    }

    const api = readNativeApi() ?? ensureNativeApi();
    const confirmed = await api.dialogs.confirm(
      [t("settings.advanced.repairState"), t("settings.advanced.repairStateDescription")].join(
        "\n",
      ),
    );
    if (!confirmed) {
      return;
    }

    setIsRepairingLocalState(true);
    try {
      const snapshot = await api.orchestration.repairState();
      syncServerReadModel(snapshot);
      toastManager.add({
        type: "success",
        title: t("settings.advanced.repairSucceeded"),
        description: t("settings.advanced.repairSucceededDescription"),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings.advanced.repairFailed"),
        description:
          error instanceof Error ? error.message : t("settings.advanced.repairFailedGeneric"),
      });
    } finally {
      setIsRepairingLocalState(false);
    }
  }, [isRepairingLocalState, syncServerReadModel]);

  const deleteManagedWorktree = useCallback(
    async (input: { workspaceRoot: string; worktreePath: string }) => {
      const api = readNativeApi() ?? ensureNativeApi();
      const displayName = formatWorktreePathForDisplay(input.worktreePath);
      const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
      if (snapshot === null) {
        toastManager.add({
          type: "error",
          title: t("settings.worktrees.couldNotVerifyConversations"),
          description: t("settings.worktrees.retryOnReconnect"),
        });
        return;
      }

      const linkedThreadsFromSnapshot = snapshot.threads.filter((thread) => {
        const candidatePaths = [
          normalizeManagedWorktreePath(thread.worktreePath),
          normalizeManagedWorktreePath(thread.associatedWorktreePath ?? null),
        ];
        return candidatePaths.includes(input.worktreePath);
      });
      const linkedArchivedThreadIds = linkedThreadsFromSnapshot
        .filter((thread) => (thread.archivedAt ?? null) !== null)
        .map((thread) => thread.id);
      const linkedActiveThreadCount = linkedThreadsFromSnapshot.filter(
        (thread) => (thread.archivedAt ?? null) === null,
      ).length;
      const linkedConversationCount = linkedActiveThreadCount + linkedArchivedThreadIds.length;
      const confirmed = await api.dialogs.confirm(
        linkedConversationCount > 0
          ? [
              t("settings.worktrees.deleteWorktree", { name: displayName }),
              "",
              t("settings.worktrees.linkedConversations", {
                active: linkedActiveThreadCount,
                archived: linkedArchivedThreadIds.length,
              }),
              linkedArchivedThreadIds.length > 0
                ? t("settings.worktrees.archivedWillBeDeleted")
                : t("settings.worktrees.mayBreakReopening"),
              "",
              t("settings.worktrees.deleteAnyway"),
            ].join("\n")
          : [
              t("settings.worktrees.deleteWorktree", { name: displayName }),
              t("settings.worktrees.removesFromDisk"),
            ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      try {
        await deleteArchivedThreadsFromClient({
          api: api.orchestration,
          threadIds: linkedArchivedThreadIds,
          removeDeletedThreadFromClientState,
        });

        await removeWorktreeMutation.mutateAsync({
          cwd: input.workspaceRoot,
          path: input.worktreePath,
          force: true,
        });
        await queryClient.invalidateQueries({
          queryKey: serverQueryKeys.worktrees(),
        });
        toastManager.add({
          type: "success",
          title: t("settings.worktrees.worktreeDeleted"),
          description:
            linkedArchivedThreadIds.length > 0
              ? t("settings.worktrees.worktreeDeletedWithArchived", {
                  name: displayName,
                  count: linkedArchivedThreadIds.length,
                })
              : t("settings.worktrees.worktreeDeletedSimple", { name: displayName }),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings.worktrees.couldNotDeleteWorktree"),
          description:
            error instanceof Error ? error.message : t("settings.worktrees.deleteFailedGeneric"),
        });
      }
    },
    [queryClient, removeDeletedThreadFromClientState, removeWorktreeMutation],
  );

  const unarchiveThread = useCallback(
    async (threadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      try {
        await unarchiveThreadFromClient(api.orchestration, threadId);
        toastManager.add({
          type: "success",
          title: t("settings.archived.threadRestored"),
          description: t("settings.archived.threadRestoredDescription"),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings.archived.couldNotRestore"),
          description:
            error instanceof Error ? error.message : t("settings.archived.restoreFailedGeneric"),
        });
      }
    },
    [t],
  );

  const deleteArchivedThread = useCallback(
    async (threadId: ThreadId, threadTitle: string) => {
      const api = readNativeApi();
      if (!api) return;

      const confirmed = await api.dialogs.confirm(
        t("settings.archived.deleteConfirmation", { title: threadTitle }),
      );
      if (!confirmed) return;

      try {
        await deleteArchivedThreadFromClient({
          api: api.orchestration,
          threadId,
          removeDeletedThreadFromClientState,
        });
        toastManager.add({
          type: "success",
          title: t("settings.archived.threadDeleted"),
          description: t("settings.archived.threadDeletedDescription"),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings.archived.couldNotDelete"),
          description:
            error instanceof Error ? error.message : t("settings.archived.deleteFailedGeneric"),
        });
      }
    },
    [removeDeletedThreadFromClientState, t],
  );

  const handleArchivedThreadContextMenu = useCallback(
    async (threadId: ThreadId, threadTitle: string, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;

      const clicked = await api.contextMenu.show(
        [
          { id: "restore", label: t("settings.archived.contextMenuRestore") },
          { id: "delete", label: t("settings.archived.contextMenuDelete"), destructive: true },
        ],
        position,
      );

      if (clicked === "restore") {
        await unarchiveThread(threadId);
        return;
      }

      if (clicked === "delete") {
        await deleteArchivedThread(threadId, threadTitle);
      }
    },
    [deleteArchivedThread, unarchiveThread],
  );

  // Shared on/off settings row: a labelled Switch bound to a boolean AppSettings
  // key, with the standard "reset to default" affordance shown only when changed.
  // Rows with bespoke controls (e.g. the desktop-notifications Test button) keep
  // their own markup instead of using this helper.
  const renderBooleanSettingRow = (config: {
    settingKey: BooleanSettingKey;
    title: string;
    description: string;
    resetLabel: string;
    ariaLabel: string;
    anchorId?: string;
  }) => {
    const { settingKey, title, description, resetLabel, ariaLabel, anchorId } = config;
    const isChanged = settings[settingKey] !== defaults[settingKey];
    return (
      <SettingsRow
        title={title}
        description={description}
        {...(anchorId && { anchorId })}
        resetAction={
          isChanged ? (
            <SettingResetButton
              label={resetLabel}
              onClick={() =>
                updateSettings({ [settingKey]: defaults[settingKey] } as Partial<AppSettings>)
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings[settingKey]}
            onCheckedChange={(checked) =>
              updateSettings({ [settingKey]: Boolean(checked) } as Partial<AppSettings>)
            }
            aria-label={ariaLabel}
          />
        }
      />
    );
  };

  const renderGeneralPanel = () => (
    <div className="space-y-6">
      <SettingsSection title={t("settings.general.coreDefaults")}>
        <SettingsRow
          title={t("settings.general.language")}
          description={t("settings.general.languageDescription")}
          anchorId="setting-general-language"
          control={
            <SettingsSelectControl
              value={settings.locale}
              onValueChange={(value) => {
                if (value !== "en" && value !== "zh-CN") return;
                updateSettings({ locale: value });
                i18n.changeLanguage(value);
                void ensureNativeApi().server.setLocale({ locale: value });
              }}
              ariaLabel={t("settings.general.languageAria")}
              valueContent={settings.locale === "zh-CN" ? "简体中文" : "English"}
            >
              <SelectItem key="en" value="en">
                English
              </SelectItem>
              <SelectItem key="zh-CN" value="zh-CN">
                简体中文
              </SelectItem>
            </SettingsSelectControl>
          }
        />
        <SettingsRow
          title={t("settings.general.defaultProvider")}
          description={t("settings.general.defaultProviderDescription")}
          anchorId="setting-general-default-provider"
          resetAction={
            settings.defaultProvider !== defaults.defaultProvider ? (
              <SettingResetButton
                label={t("settings.general.defaultProvider")}
                onClick={() => updateSettings({ defaultProvider: defaults.defaultProvider })}
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.defaultProvider}
              onValueChange={(value) => {
                if (!isProviderSelectOption(value)) return;
                updateSettings({ defaultProvider: value });
              }}
              ariaLabel={t("settings.general.defaultProvider")}
              valueContent={
                <ProviderOptionLabel
                  provider={settings.defaultProvider}
                  label={PROVIDER_DISPLAY_NAMES[settings.defaultProvider]}
                />
              }
            >
              {PROVIDER_SELECT_OPTIONS.map((provider) => (
                <SelectItem hideIndicator key={provider} value={provider}>
                  <ProviderOptionLabel
                    provider={provider}
                    label={PROVIDER_DISPLAY_NAMES[provider]}
                  />
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />

        <SettingsRow
          title={t("settings.general.newThreads")}
          description={t("settings.general.newThreadsDescription")}
          anchorId="setting-general-new-threads"
          resetAction={
            settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
              <SettingResetButton
                label={t("settings.general.newThreads")}
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: defaults.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value !== "local" && value !== "worktree") return;
                updateSettings({
                  defaultThreadEnvMode: value,
                });
              }}
              ariaLabel={t("settings.general.defaultThreadMode")}
              valueContent={
                settings.defaultThreadEnvMode === "worktree"
                  ? t("settings.general.newWorktree")
                  : t("settings.general.local")
              }
            >
              <SelectItem hideIndicator value="local">
                {t("settings.general.local")}
              </SelectItem>
              <SelectItem hideIndicator value="worktree">
                {t("settings.general.newWorktree")}
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>

      <SettingsSection title={t("settings.general.sidebarOrganization")}>
        <SettingsRow
          title={t("settings.general.projectOrder")}
          description={t("settings.general.projectOrderDescription")}
          anchorId="setting-general-project-order"
          resetAction={
            settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder ? (
              <SettingResetButton
                label={t("settings.general.projectOrder")}
                onClick={() =>
                  updateSettings({
                    sidebarProjectSortOrder: defaults.sidebarProjectSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.sidebarProjectSortOrder}
              onValueChange={(value) => {
                if (value !== "updated_at" && value !== "created_at" && value !== "manual") {
                  return;
                }
                updateSettings({ sidebarProjectSortOrder: value });
              }}
              ariaLabel={t("settings.general.projectOrder")}
              valueContent={t(SIDEBAR_PROJECT_SORT_ORDER_KEYS[settings.sidebarProjectSortOrder])}
            >
              <SelectItem hideIndicator value="updated_at">
                {t(SIDEBAR_PROJECT_SORT_ORDER_KEYS.updated_at)}
              </SelectItem>
              <SelectItem hideIndicator value="created_at">
                {t(SIDEBAR_PROJECT_SORT_ORDER_KEYS.created_at)}
              </SelectItem>
              <SelectItem hideIndicator value="manual">
                {t(SIDEBAR_PROJECT_SORT_ORDER_KEYS.manual)}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        <SettingsRow
          title={t("settings.general.threadOrder")}
          description={t("settings.general.threadOrderDescription")}
          anchorId="setting-general-thread-order"
          resetAction={
            settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder ? (
              <SettingResetButton
                label={t("settings.general.threadOrder")}
                onClick={() =>
                  updateSettings({
                    sidebarThreadSortOrder: defaults.sidebarThreadSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.sidebarThreadSortOrder}
              onValueChange={(value) => {
                if (value !== "updated_at" && value !== "created_at") {
                  return;
                }
                updateSettings({ sidebarThreadSortOrder: value });
              }}
              ariaLabel={t("settings.general.threadOrder")}
              valueContent={t(SIDEBAR_THREAD_SORT_ORDER_KEYS[settings.sidebarThreadSortOrder])}
            >
              <SelectItem hideIndicator value="updated_at">
                {t(SIDEBAR_THREAD_SORT_ORDER_KEYS.updated_at)}
              </SelectItem>
              <SelectItem hideIndicator value="created_at">
                {t(SIDEBAR_THREAD_SORT_ORDER_KEYS.created_at)}
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>

      <SettingsSection title={t("settings.general.sidebarSections")}>
        {renderBooleanSettingRow({
          settingKey: "showChatsSection",
          title: t("settings.general.chats"),
          description: t("settings.general.chatsDescription"),
          resetLabel: t("settings.general.chats"),
          ariaLabel: t("settings.general.chatsAria"),
          anchorId: "setting-general-chats",
        })}

        {renderBooleanSettingRow({
          settingKey: "showWorkspaceSection",
          title: t("settings.general.workspace"),
          description: t("settings.general.workspaceDescription"),
          resetLabel: t("settings.general.workspace"),
          ariaLabel: t("settings.general.workspaceAria"),
          anchorId: "setting-general-workspace",
        })}
      </SettingsSection>

      <div ref={environmentPanelRef} id={SETTINGS_TARGETS.environmentPanel}>
        <SettingsSection title={t("settings.general.environmentPanel")}>
          {renderBooleanSettingRow({
            settingKey: "showEnvironmentUsage",
            title: t("settings.general.usage"),
            description: t("settings.general.usageDescription"),
            resetLabel: t("settings.general.usage"),
            ariaLabel: t("settings.general.usageAria"),
            anchorId: "setting-general-usage",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentRepository",
            title: t("settings.general.repository"),
            description: t("settings.general.repositoryDescription"),
            resetLabel: t("settings.general.repository"),
            ariaLabel: t("settings.general.repositoryAria"),
            anchorId: "setting-general-repository",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentPullRequest",
            title: "Pull request",
            description:
              "Show the open pull request (CI checks and review comments) for the current branch in the chat Environment panel.",
            resetLabel: "pull request section",
            ariaLabel: "Show the Pull request section in the Environment panel",
            anchorId: "setting-general-pull-request",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentEditor",
            title: t("settings.general.editor"),
            description: t("settings.general.editorDescription"),
            resetLabel: t("settings.general.editor"),
            ariaLabel: t("settings.general.editorAria"),
            anchorId: "setting-general-editor",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentRecap",
            title: t("settings.general.recap"),
            description: t("settings.general.recapDescription"),
            resetLabel: t("settings.general.recap"),
            ariaLabel: t("settings.general.recapAria"),
            anchorId: "setting-general-recap",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentPinned",
            title: t("settings.general.pinnedMessages"),
            description: t("settings.general.pinnedMessagesDescription"),
            resetLabel: t("settings.general.pinnedMessages"),
            ariaLabel: t("settings.general.pinnedMessagesAria"),
            anchorId: "setting-general-pinned-messages",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentMarkers",
            title: t("settings.general.textMarkers"),
            description: t("settings.general.textMarkersDescription"),
            resetLabel: t("settings.general.textMarkers"),
            ariaLabel: t("settings.general.textMarkersAria"),
            anchorId: "setting-general-text-markers",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentInstructions",
            title: t("settings.general.projectInstructions"),
            description: t("settings.general.projectInstructionsDescription"),
            resetLabel: t("settings.general.projectInstructions"),
            ariaLabel: t("settings.general.projectInstructionsAria"),
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentNotepad",
            title: t("settings.general.notepad"),
            description: t("settings.general.notepadDescription"),
            resetLabel: t("settings.general.notepad"),
            ariaLabel: t("settings.general.notepadAria"),
            anchorId: "setting-general-notepad",
          })}
        </SettingsSection>
      </div>
    </div>
  );

  const renderAppearancePanel = () => (
    <div className="space-y-6">
      <section className={SETTINGS_PANEL_SECTION_CLASS_NAME}>
        <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>
          {t("settings.appearance.themeAndTypography")}
        </h2>
        <SettingsCard>
          <SettingsRow
            title={t("settings.appearance.theme")}
            description={t("settings.appearance.themeDescription")}
            anchorId="setting-appearance-theme"
            resetAction={
              theme !== "system" ? (
                <SettingResetButton
                  label={t("settings.appearance.theme")}
                  onClick={() => setTheme("system")}
                />
              ) : null
            }
            control={
              <SettingsSegmentedControl
                value={theme}
                onValueChange={(value) => {
                  if (value !== "system" && value !== "light" && value !== "dark") return;
                  setTheme(value);
                }}
                ariaLabel={t("settings.appearance.themeAria")}
                options={THEME_OPTIONS.map((opt) => ({
                  ...opt,
                  label: t(`settings.appearance.themeOptions.${opt.value}` as const),
                  description: t(
                    `settings.appearance.themeOptions.${opt.value}Description` as const,
                  ),
                }))}
              />
            }
          />
        </SettingsCard>

        <div className="space-y-3">
          {(resolvedTheme === "dark"
            ? (["dark", "light"] as const)
            : (["light", "dark"] as const)
          ).map((variant) => (
            <ThemePackEditor
              key={variant}
              variant={variant}
              isActive={resolvedTheme === variant}
              mode={theme}
            />
          ))}
        </div>

        <SettingsCard>
          <SettingsRow
            title={t("settings.appearance.uiDensity")}
            description={t("settings.appearance.uiDensityDescription")}
            anchorId="setting-appearance-ui-density"
            resetAction={
              settings.uiDensity !== defaults.uiDensity ? (
                <SettingResetButton
                  label={t("settings.appearance.uiDensity")}
                  onClick={() =>
                    updateSettings({
                      uiDensity: DEFAULT_UI_DENSITY,
                    })
                  }
                />
              ) : null
            }
            control={
              <SettingsSegmentedControl
                value={settings.uiDensity}
                onValueChange={(value) => {
                  if (!isUiDensity(value)) {
                    return;
                  }
                  updateSettings({ uiDensity: value });
                }}
                ariaLabel={t("settings.appearance.uiDensity")}
                options={UI_DENSITY_OPTIONS.map((opt) => ({
                  ...opt,
                  label: t(`settings.appearance.densityOptions.${opt.value}` as const),
                  description: t(
                    `settings.appearance.densityOptions.${opt.value}Description` as const,
                  ),
                }))}
              />
            }
          />

          <SettingsRow
            title={t("settings.appearance.baseFontSize")}
            description={t("settings.appearance.baseFontSizeDescription")}
            anchorId="setting-appearance-base-font-size"
            resetAction={
              settings.chatFontSizePx !== defaults.chatFontSizePx ? (
                <SettingResetButton
                  label={t("settings.appearance.baseFontSize")}
                  onClick={() =>
                    updateSettings({
                      chatFontSizePx: defaults.chatFontSizePx,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                <Input
                  type="number"
                  size="sm"
                  min={MIN_CHAT_FONT_SIZE_PX}
                  max={MAX_CHAT_FONT_SIZE_PX}
                  step={1}
                  inputMode="numeric"
                  variant="soft"
                  className="w-full text-right sm:w-20"
                  value={String(settings.chatFontSizePx)}
                  onChange={(event) => {
                    const nextValue = event.target.value.trim();
                    if (nextValue.length === 0) return;
                    updateSettings({
                      chatFontSizePx: normalizeChatFontSizePx(Number(nextValue)),
                    });
                  }}
                  aria-label={t("settings.appearance.baseFontSizeAria")}
                />
                <span className="text-xs text-muted-foreground">{t("settings.appearance.px")}</span>
              </div>
            }
          />

          <SettingsRow
            title={t("settings.appearance.terminalFontSize")}
            description={t("settings.appearance.terminalFontSizeDescription")}
            anchorId="setting-appearance-terminal-font-size"
            resetAction={
              settings.terminalFontSizePx !== defaults.terminalFontSizePx ? (
                <SettingResetButton
                  label={t("settings.appearance.terminalFontSize")}
                  onClick={() =>
                    updateSettings({
                      terminalFontSizePx: defaults.terminalFontSizePx,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                <Input
                  type="number"
                  size="sm"
                  min={MIN_TERMINAL_FONT_SIZE_PX}
                  max={MAX_TERMINAL_FONT_SIZE_PX}
                  step={1}
                  inputMode="numeric"
                  variant="soft"
                  className="w-full text-right sm:w-20"
                  value={String(settings.terminalFontSizePx)}
                  onChange={(event) => {
                    const nextValue = event.target.value.trim();
                    if (nextValue.length === 0) return;
                    updateSettings({
                      terminalFontSizePx: normalizeTerminalFontSizePx(Number(nextValue)),
                    });
                  }}
                  aria-label={t("settings.appearance.terminalFontSizeAria")}
                />
                <span className="text-xs text-muted-foreground">{t("settings.appearance.px")}</span>
              </div>
            }
          />

          <SettingsRow
            title={t("settings.appearance.terminalFont")}
            description={t("settings.appearance.terminalFontDescription")}
            anchorId="setting-appearance-terminal-font"
            resetAction={
              settings.terminalFontFamily !== defaults.terminalFontFamily ? (
                <SettingResetButton
                  label={t("settings.appearance.terminalFont")}
                  onClick={() =>
                    updateSettings({
                      terminalFontFamily: defaults.terminalFontFamily,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex w-full items-center justify-end sm:w-auto">
                <Autocomplete
                  items={visibleTerminalFontFamilySuggestions}
                  mode="none"
                  openOnInputClick
                  value={settings.terminalFontFamily}
                  onValueChange={(value) => {
                    updateSettings({
                      terminalFontFamily: normalizeTerminalFontFamily(value),
                    });
                  }}
                >
                  <AutocompleteInput
                    size="sm"
                    variant="soft"
                    showTrigger
                    showClear={settings.terminalFontFamily.length > 0}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t("settings.appearance.terminalFontPlaceholder")}
                    className="w-full sm:w-56"
                    aria-label={t("settings.appearance.terminalFont")}
                  />
                  <AutocompletePopup className="w-56 min-w-56 font-system-ui">
                    <AutocompleteList>
                      {visibleTerminalFontFamilySuggestions.map((suggestion, index) => (
                        <AutocompleteItem
                          key={suggestion}
                          index={index}
                          value={suggestion}
                          className="font-normal text-[var(--color-text-foreground)]"
                          onClick={() => {
                            updateSettings({
                              terminalFontFamily: normalizeTerminalFontFamily(suggestion),
                            });
                          }}
                        >
                          {suggestion}
                        </AutocompleteItem>
                      ))}
                      <AutocompleteEmpty>
                        {t("settings.appearance.terminalFontNoMatches")}
                      </AutocompleteEmpty>
                    </AutocompleteList>
                  </AutocompletePopup>
                </Autocomplete>
              </div>
            }
          />

          {shouldShowFontSmoothing
            ? renderBooleanSettingRow({
                settingKey: "enableNativeFontSmoothing",
                title: t("settings.appearance.fontSmoothing"),
                description: t("settings.appearance.fontSmoothingDescription"),
                resetLabel: t("settings.appearance.fontSmoothing"),
                ariaLabel: t("settings.appearance.fontSmoothingAria"),
                anchorId: "setting-appearance-font-smoothing",
              })
            : null}
        </SettingsCard>
      </section>

      <SettingsSection title={t("settings.appearance.timeAndReading")}>
        <SettingsRow
          title={t("settings.appearance.timeFormat")}
          description={t("settings.appearance.timeFormatDescription")}
          anchorId="setting-appearance-time-format"
          resetAction={
            settings.timestampFormat !== defaults.timestampFormat ? (
              <SettingResetButton
                label={t("settings.appearance.timeFormat")}
                onClick={() =>
                  updateSettings({
                    timestampFormat: defaults.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value !== "locale" && value !== "12-hour" && value !== "24-hour") {
                  return;
                }
                updateSettings({
                  timestampFormat: value,
                });
              }}
              ariaLabel={t("settings.appearance.timeFormat")}
              triggerClassName="w-full sm:w-40"
              valueContent={t(`settings.appearance.timestamp.${settings.timestampFormat}` as const)}
            >
              <SelectItem hideIndicator value="locale">
                {t("settings.appearance.timestamp.locale")}
              </SelectItem>
              <SelectItem hideIndicator value="12-hour">
                {t("settings.appearance.timestamp.12-hour")}
              </SelectItem>
              <SelectItem hideIndicator value="24-hour">
                {t("settings.appearance.timestamp.24-hour")}
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>
    </div>
  );

  const renderNotificationsPanel = () => (
    <div className="space-y-6">
      <SettingsSection title={t("settings.notifications.activityAlerts")}>
        {renderBooleanSettingRow({
          settingKey: "enableTaskCompletionToasts",
          title: t("settings.notifications.activityToasts"),
          description: t("settings.notifications.activityToastsDescription"),
          resetLabel: t("settings.notifications.activityToasts"),
          ariaLabel: t("settings.notifications.activityToastsAria"),
          anchorId: "setting-notifications-activity-toasts",
        })}

        <SettingsRow
          title={t("settings.notifications.desktopNotifications")}
          description={t("settings.notifications.desktopNotificationsDescription")}
          status={buildNotificationSettingsSupportText(browserNotificationPermission)}
          anchorId="setting-notifications-desktop-notifications"
          resetAction={
            settings.enableSystemTaskCompletionNotifications !==
            defaults.enableSystemTaskCompletionNotifications ? (
              <SettingResetButton
                label={t("settings.notifications.desktopNotifications")}
                onClick={() =>
                  updateSettings({
                    enableSystemTaskCompletionNotifications:
                      defaults.enableSystemTaskCompletionNotifications,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
              <Button size="xs" variant="outline" onClick={() => void sendTestNotification()}>
                {t("settings.notifications.test")}
              </Button>
              <Switch
                checked={settings.enableSystemTaskCompletionNotifications}
                onCheckedChange={(checked) => {
                  void setSystemNotificationsEnabled(Boolean(checked));
                }}
                aria-label={t("settings.notifications.desktopNotificationsAria")}
              />
            </div>
          }
        />
      </SettingsSection>
    </div>
  );

  const renderBehaviorPanel = () => (
    <div className="space-y-6">
      <SettingsSection title={t("settings.behavior.runtimeBehavior")}>
        {renderBooleanSettingRow({
          settingKey: "enableAssistantStreaming",
          title: t("settings.behavior.assistantOutput"),
          description: t("settings.behavior.assistantOutputDescription"),
          resetLabel: t("settings.behavior.assistantOutput"),
          ariaLabel: t("settings.behavior.assistantOutputAria"),
          anchorId: "setting-behavior-assistant-output",
        })}

        {renderBooleanSettingRow({
          settingKey: "diffWordWrap",
          title: t("settings.behavior.diffLineWrapping"),
          description: t("settings.behavior.diffLineWrappingDescription"),
          resetLabel: t("settings.behavior.diffLineWrapping"),
          ariaLabel: t("settings.behavior.diffLineWrappingAria"),
          anchorId: "setting-behavior-diff-line-wrapping",
        })}
      </SettingsSection>

      <SettingsSection title={t("settings.behavior.safetyConfirmations")}>
        {renderBooleanSettingRow({
          settingKey: "confirmThreadDelete",
          title: t("settings.behavior.deleteConfirmation"),
          description: t("settings.behavior.deleteConfirmationDescription"),
          resetLabel: t("settings.behavior.deleteConfirmation"),
          ariaLabel: t("settings.behavior.deleteConfirmationAria"),
          anchorId: "setting-behavior-delete-confirmation",
        })}

        {renderBooleanSettingRow({
          settingKey: "confirmThreadArchive",
          title: t("settings.behavior.archiveConfirmation"),
          description: t("settings.behavior.archiveConfirmationDescription"),
          resetLabel: t("settings.behavior.archiveConfirmation"),
          ariaLabel: t("settings.behavior.archiveConfirmationAria"),
          anchorId: "setting-behavior-archive-confirmation",
        })}

        {renderBooleanSettingRow({
          settingKey: "confirmTerminalTabClose",
          title: t("settings.behavior.terminalCloseConfirmation"),
          description: t("settings.behavior.terminalCloseConfirmationDescription"),
          resetLabel: t("settings.behavior.terminalCloseConfirmation"),
          ariaLabel: t("settings.behavior.terminalCloseConfirmationAria"),
          anchorId: "setting-behavior-terminal-close-confirmation",
        })}
      </SettingsSection>
    </div>
  );

  const renderWorktreesPanel = () => {
    if (serverWorktreesQuery.isLoading) {
      return (
        <div
          className={cn(SETTINGS_EMPTY_STATE_CLASS_NAME, "px-4 py-6 text-sm text-muted-foreground")}
        >
          {t("settings.worktrees.loading")}
        </div>
      );
    }
    if (serverWorktreesQuery.isError) {
      return (
        <div
          className={cn(
            SETTINGS_EMPTY_STATE_CLASS_NAME,
            "border-destructive/30 bg-destructive/5 px-4 py-6 text-sm text-destructive",
          )}
        >
          {serverWorktreesQuery.error instanceof Error
            ? serverWorktreesQuery.error.message
            : t("settings.worktrees.unableToLoad")}
        </div>
      );
    }
    if (worktreesByWorkspaceRoot.length === 0) {
      return (
        <div
          className={cn(SETTINGS_EMPTY_STATE_CLASS_NAME, "px-4 py-6 text-sm text-muted-foreground")}
        >
          {t("settings.worktrees.noWorktreesFound")}
        </div>
      );
    }

    // Each workspace root is a standard settings card; worktree rows reuse the
    // same row chrome/typography as every other settings list (separators come
    // from the card's `divide-y`), with their richer body kept top-aligned.
    return (
      <div className="space-y-6">
        {worktreesByWorkspaceRoot.map((group) => (
          <SettingsSection key={group.workspaceRoot} title={group.workspaceRoot}>
            {group.worktrees.map((worktree) => {
              const deleteDisabled = removeWorktreeMutation.isPending;
              return (
                <div
                  key={worktree.path}
                  className={SETTINGS_CARD_ROW_CLASS_NAME}
                  data-slot="settings-row"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="space-y-0.5">
                        <div className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>
                          {t("settings.worktrees.worktree")}
                        </div>
                        <div
                          className={cn(
                            SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
                            "truncate font-mono",
                          )}
                        >
                          {worktree.path}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="text-[11px] font-medium text-muted-foreground">
                          {t("settings.worktrees.conversations")}
                        </div>
                        {worktree.linkedThreads.length > 0 ? (
                          <div className="space-y-1">
                            {worktree.linkedThreads.map((thread) => (
                              <div
                                key={thread.id}
                                className={cn(
                                  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
                                  "text-foreground",
                                )}
                              >
                                {thread.title}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
                            {t("settings.worktrees.noConversations")}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex w-full shrink-0 flex-col items-end gap-2 sm:w-auto">
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={deleteDisabled}
                        onClick={() =>
                          void deleteManagedWorktree({
                            workspaceRoot: group.workspaceRoot,
                            worktreePath: worktree.path,
                          })
                        }
                      >
                        {t("settings.worktrees.delete")}
                      </Button>
                      {worktree.linkedThreads.length > 0 ? (
                        <p
                          className={cn(
                            SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
                            "max-w-40 text-right",
                          )}
                        >
                          {t("settings.worktrees.linkedConversationsExist")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </SettingsSection>
        ))}
      </div>
    );
  };

  const renderArchivedPanel = () => {
    const archivedGroups = [
      ...projects.map((project) => ({
        project,
        threads: archivedThreads
          .filter((thread) => thread.projectId === project.id)
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.updatedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.updatedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
      })),
      ...(() => {
        const knownProjectIds = new Set(projects.map((project) => project.id));
        const orphanedThreads = archivedThreads
          .filter((thread) => !knownProjectIds.has(thread.projectId))
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.updatedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.updatedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          });
        return orphanedThreads.length > 0
          ? [
              {
                project: null,
                threads: orphanedThreads,
              },
            ]
          : [];
      })(),
    ].filter((group) => group.threads.length > 0);

    if (archivedGroups.length === 0) {
      return (
        <div className={cn(SETTINGS_EMPTY_STATE_CLASS_NAME, "px-5 py-10 text-center")}>
          <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full border border-border/70 bg-background/70 text-muted-foreground">
            <ArchiveIcon className="size-5" />
          </div>
          <div className="text-sm font-medium text-foreground">
            {t("settings.archived.noArchivedThreads")}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {t("settings.archived.archivedThreadsHere")}
          </div>
        </div>
      );
    }

    // Each project group is a standard settings card (label + bordered list); the
    // thread rows reuse the same row/typography tokens as every other settings row,
    // and the card's own `divide-y` draws the separators.
    return (
      <div className="space-y-6">
        {archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project?.id ?? "unknown-project"}
            title={project?.name ?? t("settings.archived.unknownProject")}
          >
            {projectThreads.map((thread) => (
              <SettingsListRow
                key={thread.id}
                title={thread.title}
                description={t("settings.archived.archivedRelative", {
                  time: formatRelativeTime(thread.archivedAt ?? thread.createdAt),
                })}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleArchivedThreadContextMenu(thread.id, thread.title, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                actions={
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void unarchiveThread(thread.id)}
                    >
                      {t("settings.archived.restore")}
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      onClick={() => void deleteArchivedThread(thread.id, thread.title)}
                    >
                      {t("settings.archived.delete")}
                    </Button>
                  </>
                }
              />
            ))}
          </SettingsSection>
        ))}
      </div>
    );
  };

  const renderModelsPanel = () => (
    <div className="space-y-6">
      <SettingsSection title={t("settings.models.generationDefaults")}>
        <SettingsRow
          title={t("settings.models.gitWritingModel")}
          description={t("settings.models.gitWritingModelDescription")}
          anchorId="setting-models-git-writing-model"
          resetAction={
            isGitTextGenerationModelDirty ? (
              <SettingResetButton
                label={t("settings.models.gitWritingModel")}
                onClick={() =>
                  updateSettings({
                    textGenerationProvider: defaults.textGenerationProvider,
                    textGenerationModel: defaults.textGenerationModel,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={currentGitTextGenerationValue}
              onValueChange={(value) => {
                if (!value) return;
                const separatorIndex = value.indexOf(":");
                const provider = value.slice(0, separatorIndex) as ProviderKind;
                const model = value.slice(separatorIndex + 1);
                if (!provider || !model) return;
                updateSettings({
                  textGenerationProvider: provider,
                  textGenerationModel: model,
                });
              }}
              ariaLabel={t("settings.models.gitWritingModel")}
              triggerClassName="w-full sm:w-52"
              valueContent={selectedGitTextGenerationModelLabel}
            >
              {gitTextGenerationModelOptions.map((option) => (
                <SelectItem
                  hideIndicator
                  key={`${option.provider}:${option.slug}`}
                  value={`${option.provider}:${option.slug}`}
                >
                  {PROVIDER_DISPLAY_NAMES[option.provider]} / {option.name}
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />
      </SettingsSection>

      <SettingsSection title={t("settings.models.customModels")}>
        <SettingsRow
          title={t("settings.models.savedModelSlugs")}
          description={t("settings.models.savedModelSlugsDescription")}
          anchorId="setting-models-saved-model-slugs"
          resetAction={
            totalCustomModels > 0 ? (
              <SettingResetButton
                label={t("settings.models.customModels")}
                onClick={() => {
                  updateSettings({
                    customCodexModels: defaults.customCodexModels,
                    customClaudeModels: defaults.customClaudeModels,
                    customCursorModels: defaults.customCursorModels,
                    customGeminiModels: defaults.customGeminiModels,
                    customGrokModels: defaults.customGrokModels,
                    customKiloModels: defaults.customKiloModels,
                    customOpenCodeModels: defaults.customOpenCodeModels,
                    customPiModels: defaults.customPiModels,
                  });
                  setCustomModelErrorByProvider({});
                  setShowAllCustomModels(false);
                }}
              />
            ) : null
          }
        >
          <div className={cn("mt-4 pt-4", SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME)}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={selectedCustomModelProvider}
                onValueChange={(value) => {
                  if (
                    value !== "codex" &&
                    value !== "claudeAgent" &&
                    value !== "cursor" &&
                    value !== "gemini" &&
                    value !== "grok" &&
                    value !== "kilo" &&
                    value !== "opencode" &&
                    value !== "pi"
                  ) {
                    return;
                  }
                  setSelectedCustomModelProvider(value);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t("settings.models.customModelProvider")}
                >
                  <SelectValue>{selectedCustomModelProviderSettings.title}</SelectValue>
                </SelectTrigger>
                <SettingsSelectPopup align="start">
                  {MODEL_PROVIDER_SETTINGS.map((providerSettings) => (
                    <SelectItem
                      hideIndicator
                      key={providerSettings.provider}
                      value={providerSettings.provider}
                    >
                      {providerSettings.title}
                    </SelectItem>
                  ))}
                </SettingsSelectPopup>
              </Select>
              <Input
                id="custom-model-slug"
                size="sm"
                variant="soft"
                value={selectedCustomModelInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setCustomModelInputByProvider((existing) => ({
                    ...existing,
                    [selectedCustomModelProvider]: value,
                  }));
                  if (selectedCustomModelError) {
                    setCustomModelErrorByProvider((existing) => ({
                      ...existing,
                      [selectedCustomModelProvider]: null,
                    }));
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addCustomModel(selectedCustomModelProvider);
                }}
                placeholder={selectedCustomModelProviderSettings.example}
                spellCheck={false}
              />
              <Button
                className="shrink-0"
                variant="outline"
                onClick={() => addCustomModel(selectedCustomModelProvider)}
              >
                <PlusIcon className="size-3.5" />
                {t("settings.models.add")}
              </Button>
            </div>

            {selectedCustomModelError ? (
              <p className="mt-2 text-xs text-destructive">{selectedCustomModelError}</p>
            ) : null}

            {totalCustomModels > 0 ? (
              <div className={cn("mt-3", SETTINGS_INSET_LIST_CLASS_NAME)}>
                {visibleCustomModelRows.map((row) => (
                  <div
                    key={row.key}
                    className="group grid grid-cols-[minmax(5rem,6rem)_minmax(0,1fr)_auto] items-center gap-3 border-t border-[color:var(--color-border)] px-4 py-2 first:border-t-0"
                  >
                    <span className="truncate text-xs text-muted-foreground">
                      {row.providerTitle}
                    </span>
                    <code className="min-w-0 truncate text-sm text-foreground">{row.slug}</code>
                    <button
                      type="button"
                      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100"
                      aria-label={t("settings.models.removeModel", { slug: row.slug })}
                      onClick={() => removeCustomModel(row.provider, row.slug)}
                    >
                      <XIcon className="size-3.5 text-muted-foreground hover:text-foreground" />
                    </button>
                  </div>
                ))}

                {savedCustomModelRows.length > 5 ? (
                  <button
                    type="button"
                    className="mt-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setShowAllCustomModels((value) => !value)}
                  >
                    {showAllCustomModels
                      ? t("settings.models.showLess")
                      : t("settings.models.showMore", { count: savedCustomModelRows.length - 5 })}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );

  const renderProvidersPanel = () => (
    <div className="space-y-6">
      {renderProviderUpdatesSection()}
      <SettingsSection title={t("settings.providers.providerPicker")}>
        <SettingsRow
          title={t("settings.providers.visibleProviders")}
          description={t("settings.providers.visibleProvidersDescription")}
          anchorId="setting-providers-visible-providers"
          status={
            hiddenProviderCount > 0
              ? t("settings.providers.providersHidden", { count: hiddenProviderCount })
              : isProviderOrderDirty
                ? t("settings.providers.customOrder")
                : t("settings.providers.allProvidersVisible")
          }
          resetAction={
            hiddenProviderCount > 0 || isProviderOrderDirty ? (
              <SettingResetButton
                label={t("settings.providers.providerPicker")}
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
      {renderProviderInstallsSection()}
    </div>
  );

  const renderProviderUpdatesSection = () => (
    <div ref={providerUpdatesRef} id={SETTINGS_TARGETS.providerUpdates}>
      <SettingsSection title={t("settings.providerUpdates.updates")}>
        {renderBooleanSettingRow({
          settingKey: "enableProviderUpdateChecks",
          title: t("settings.providerUpdates.automaticCliUpdateChecks"),
          description: t("settings.providerUpdates.automaticCliUpdateChecksDescription"),
          resetLabel: t("settings.providerUpdates.automaticCliUpdateChecks"),
          ariaLabel: t("settings.providerUpdates.automaticCliUpdateChecks"),
          anchorId: "setting-providers-automatic-cli-update-checks",
        })}

        <SettingsRow
          title={t("settings.providerUpdates.providerUpdates")}
          description={t("settings.providerUpdates.providerUpdatesDescription")}
          anchorId="setting-providers-provider-updates"
          status={
            !settings.enableProviderUpdateChecks
              ? t("settings.providerUpdates.automaticChecksOff")
              : outdatedProviderCount > 0
                ? t("settings.providerUpdates.updatesAvailable", { count: outdatedProviderCount })
                : t("settings.providerUpdates.noUpdatesDetected")
          }
        >
          {settings.enableProviderUpdateChecks && outdatedProviderStatuses.length > 0 ? (
            <div
              className={cn(
                "mt-4",
                SETTINGS_INSET_LIST_CLASS_NAME,
                "divide-y divide-[color:var(--color-border)]",
              )}
            >
              {outdatedProviderStatuses.map((providerStatus) => {
                const updateAdvisory = providerStatus.versionAdvisory;
                const updateState = providerStatus.updateState?.status;
                const isProviderUpdateActive =
                  updateState === "queued" ||
                  updateState === "running" ||
                  updatingProviders.has(providerStatus.provider);
                const canUpdateProvider =
                  updateAdvisory?.canUpdate === true && !isProviderUpdateActive;
                const updateLabel = providerUpdateStatusLabel(providerStatus, t);

                return (
                  <SettingsListRow
                    key={providerStatus.provider}
                    title={PROVIDER_DISPLAY_NAMES[providerStatus.provider]}
                    description={updateLabel || undefined}
                    actions={
                      updateAdvisory?.canUpdate ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={!canUpdateProvider}
                          title={
                            updateAdvisory.updateCommand
                              ? t("settings.providerUpdates.runCommand", {
                                  command: updateAdvisory.updateCommand,
                                })
                              : undefined
                          }
                          onClick={() => void runProviderUpdate(providerStatus.provider)}
                        >
                          {isProviderUpdateActive ? (
                            <Loader2Icon className="size-3.5 animate-spin" />
                          ) : (
                            <DownloadIcon className="size-3.5" />
                          )}
                          {isProviderUpdateActive
                            ? t("settings.providerUpdates.updating")
                            : t("settings.providerUpdates.update")}
                        </Button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">
                          {t("settings.providerUpdates.manualUpdate")}
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
  );

  const renderProviderInstallsSection = () => (
    <div ref={providerInstallsRef} id={SETTINGS_TARGETS.providerInstalls}>
      <SettingsSection title={t("settings.providers.providerTools")}>
        <SettingsRow
          title={t("settings.providers.installedClis")}
          description={t("settings.providers.installedClisDescription")}
          anchorId="setting-providers-installed-clis"
          status={
            !settings.enableProviderUpdateChecks
              ? t("settings.providers.automaticChecksOff")
              : outdatedProviderCount > 0
                ? t("settings.providers.updatesAvailable", { count: outdatedProviderCount })
                : t("settings.providers.noUpdatesDetected")
          }
          resetAction={
            isInstallSettingsDirty ? (
              <SettingResetButton
                label={t("settings.providers.providerTools")}
                onClick={() => {
                  updateSettings({
                    claudeBinaryPath: defaults.claudeBinaryPath,
                    codexBinaryPath: defaults.codexBinaryPath,
                    codexHomePath: defaults.codexHomePath,
                    cursorBinaryPath: defaults.cursorBinaryPath,
                    cursorApiEndpoint: defaults.cursorApiEndpoint,
                    geminiBinaryPath: defaults.geminiBinaryPath,
                    grokBinaryPath: defaults.grokBinaryPath,
                    kiloBinaryPath: defaults.kiloBinaryPath,
                    kiloServerUrl: defaults.kiloServerUrl,
                    kiloServerPassword: defaults.kiloServerPassword,
                    openCodeBinaryPath: defaults.openCodeBinaryPath,
                    openCodeExperimentalWebSockets: defaults.openCodeExperimentalWebSockets,
                    openCodeServerUrl: defaults.openCodeServerUrl,
                    openCodeServerPassword: defaults.openCodeServerPassword,
                    piAgentDir: defaults.piAgentDir,
                    piBinaryPath: defaults.piBinaryPath,
                  });
                  setOpenInstallProviders({
                    codex: false,
                    claudeAgent: false,
                    cursor: false,
                    gemini: false,
                    grok: false,
                    kilo: false,
                    opencode: false,
                    pi: false,
                  });
                }}
              />
            ) : null
          }
        >
          <div className="mt-4">
            <div className={SETTINGS_INSET_LIST_CLASS_NAME}>
              {INSTALL_PROVIDER_SETTINGS.map((providerSettings) => {
                const isOpen = openInstallProviders[providerSettings.provider];
                const isDirty =
                  providerSettings.provider === "codex"
                    ? settings.codexBinaryPath !== defaults.codexBinaryPath ||
                      settings.codexHomePath !== defaults.codexHomePath
                    : providerSettings.provider === "claudeAgent"
                      ? settings.claudeBinaryPath !== defaults.claudeBinaryPath
                      : providerSettings.provider === "cursor"
                        ? settings.cursorBinaryPath !== defaults.cursorBinaryPath ||
                          settings.cursorApiEndpoint !== defaults.cursorApiEndpoint
                        : providerSettings.provider === "gemini"
                          ? settings.geminiBinaryPath !== defaults.geminiBinaryPath
                          : providerSettings.provider === "grok"
                            ? settings.grokBinaryPath !== defaults.grokBinaryPath
                            : providerSettings.provider === "kilo"
                              ? settings.kiloBinaryPath !== defaults.kiloBinaryPath ||
                                settings.kiloServerUrl !== defaults.kiloServerUrl ||
                                settings.kiloServerPassword !== defaults.kiloServerPassword
                              : providerSettings.provider === "pi"
                                ? settings.piBinaryPath !== defaults.piBinaryPath ||
                                  settings.piAgentDir !== defaults.piAgentDir
                                : settings.openCodeBinaryPath !== defaults.openCodeBinaryPath ||
                                  settings.openCodeExperimentalWebSockets !==
                                    defaults.openCodeExperimentalWebSockets ||
                                  settings.openCodeServerUrl !== defaults.openCodeServerUrl ||
                                  settings.openCodeServerPassword !==
                                    defaults.openCodeServerPassword;
                const binaryPathValue =
                  providerSettings.binaryPathKey === "claudeBinaryPath"
                    ? claudeBinaryPath
                    : providerSettings.binaryPathKey === "cursorBinaryPath"
                      ? cursorBinaryPath
                      : providerSettings.binaryPathKey === "geminiBinaryPath"
                        ? geminiBinaryPath
                        : providerSettings.binaryPathKey === "grokBinaryPath"
                          ? grokBinaryPath
                          : providerSettings.binaryPathKey === "kiloBinaryPath"
                            ? kiloBinaryPath
                            : providerSettings.binaryPathKey === "openCodeBinaryPath"
                              ? openCodeBinaryPath
                              : providerSettings.binaryPathKey === "piBinaryPath"
                                ? piBinaryPath
                                : codexBinaryPath;
                const providerStatus = providerStatusByProvider.get(providerSettings.provider);
                const showProviderUpdateStatus = providerStatus
                  ? shouldShowProviderUpdateStatus({
                      provider: providerStatus,
                      hiddenProviderSet,
                      serverSettings: providerUpdateServerSettings,
                    })
                  : false;
                const providerUpdateSuppressed =
                  providerStatus?.versionAdvisory?.status === "behind_latest" &&
                  !showProviderUpdateStatus;
                const currentProviderVersion = formatProviderVersion(providerStatus?.version);
                const providerUpdateLabel = providerStatus
                  ? !settings.enableProviderUpdateChecks
                    ? currentProviderVersion
                      ? t("settings.providers.currentVersion", { version: currentProviderVersion })
                      : null
                    : providerUpdateSuppressed
                      ? null
                      : providerUpdateStatusLabel(providerStatus, t)
                  : null;
                const updateAdvisory = providerStatus?.versionAdvisory;
                const providerUpdateState = providerStatus?.updateState?.status;
                const isProviderUpdateActive =
                  providerUpdateState === "queued" ||
                  providerUpdateState === "running" ||
                  updatingProviders.has(providerSettings.provider);
                const canUpdateProvider =
                  showProviderUpdateStatus &&
                  updateAdvisory?.status === "behind_latest" &&
                  updateAdvisory.canUpdate &&
                  !isProviderUpdateActive;
                const shouldShowProviderUpdateButton =
                  showProviderUpdateStatus &&
                  updateAdvisory?.status === "behind_latest" &&
                  updateAdvisory.canUpdate;

                const providerBinaryName =
                  providerSettings.provider === "cursor"
                    ? "cursor-agent"
                    : providerSettings.provider === "claudeAgent"
                      ? "claude"
                      : providerSettings.provider;

                return (
                  <Collapsible
                    key={providerSettings.provider}
                    open={isOpen}
                    onOpenChange={(open) =>
                      setOpenInstallProviders((existing) => ({
                        ...existing,
                        [providerSettings.provider]: open,
                      }))
                    }
                  >
                    <div className="border-t border-border/70 first:border-t-0">
                      <div className="flex min-h-11 items-center gap-2 px-3 py-2">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() =>
                            setOpenInstallProviders((existing) => ({
                              ...existing,
                              [providerSettings.provider]: !existing[providerSettings.provider],
                            }))
                          }
                        >
                          <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                            {providerSettings.title}
                          </span>
                          {isDirty ? (
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {t("settings.providers.custom")}
                            </span>
                          ) : null}
                          {providerUpdateLabel ? (
                            <span
                              className={cn(
                                "shrink-0 text-[11px]",
                                updateAdvisory?.status === "behind_latest"
                                  ? "text-foreground"
                                  : "text-muted-foreground",
                              )}
                            >
                              {providerUpdateLabel}
                            </span>
                          ) : null}
                          <ChevronDownIcon
                            className={cn(
                              "size-4 shrink-0 text-muted-foreground transition-transform",
                              isOpen && "rotate-180",
                            )}
                          />
                        </button>
                        {shouldShowProviderUpdateButton ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={!canUpdateProvider}
                            title={
                              updateAdvisory.updateCommand
                                ? t("settings.providers.runCommand", {
                                    command: updateAdvisory.updateCommand,
                                  })
                                : undefined
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              void runProviderUpdate(providerSettings.provider);
                            }}
                          >
                            {isProviderUpdateActive ? (
                              <Loader2Icon className="size-3.5 animate-spin" />
                            ) : (
                              <DownloadIcon className="size-3.5" />
                            )}
                            {isProviderUpdateActive
                              ? t("settings.providers.updating")
                              : t("settings.providers.update")}
                          </Button>
                        ) : null}
                      </div>

                      <CollapsibleContent>
                        <div className="border-t border-border/70 bg-muted/20 px-3 py-3">
                          <div className="space-y-3">
                            <ProviderDocsLinks docs={providerSettings.docs} t={t} />
                            {showProviderUpdateStatus &&
                            updateAdvisory?.status === "behind_latest" ? (
                              <div className="text-xs text-muted-foreground">
                                {updateAdvisory.canUpdate && updateAdvisory.updateCommand ? (
                                  <>
                                    <span>{t("settings.providers.command")}: </span>
                                    <code className="font-mono">
                                      {updateAdvisory.updateCommand}
                                    </code>
                                  </>
                                ) : (
                                  t("settings.providers.newerVersionAvailable")
                                )}
                              </div>
                            ) : null}

                            <label
                              htmlFor={`provider-install-${providerSettings.binaryPathKey}`}
                              className="block"
                            >
                              <span className="block text-xs font-medium text-foreground">
                                {t("settings.providers.binaryPath", {
                                  title: providerSettings.title,
                                })}
                              </span>
                              <DebouncedSettingTextInput
                                id={`provider-install-${providerSettings.binaryPathKey}`}
                                size="sm"
                                variant="soft"
                                className="mt-1"
                                value={binaryPathValue}
                                onCommit={(nextValue) =>
                                  updateSettings(
                                    providerSettings.binaryPathKey === "claudeBinaryPath"
                                      ? { claudeBinaryPath: nextValue }
                                      : providerSettings.binaryPathKey === "cursorBinaryPath"
                                        ? { cursorBinaryPath: nextValue }
                                        : providerSettings.binaryPathKey === "geminiBinaryPath"
                                          ? { geminiBinaryPath: nextValue }
                                          : providerSettings.binaryPathKey === "grokBinaryPath"
                                            ? { grokBinaryPath: nextValue }
                                            : providerSettings.binaryPathKey === "kiloBinaryPath"
                                              ? { kiloBinaryPath: nextValue }
                                              : providerSettings.binaryPathKey ===
                                                  "openCodeBinaryPath"
                                                ? { openCodeBinaryPath: nextValue }
                                                : providerSettings.binaryPathKey === "piBinaryPath"
                                                  ? { piBinaryPath: nextValue }
                                                  : { codexBinaryPath: nextValue },
                                  )
                                }
                                placeholder={t("settings.providers.binaryPath", {
                                  title: providerSettings.title,
                                })}
                                spellCheck={false}
                              />
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {providerSettings.provider === "cursor"
                                  ? t("settings.providers.leaveBlankBinaryPathCursor", {
                                      binaryName: providerBinaryName,
                                    })
                                  : t("settings.providers.leaveBlankBinaryPath", {
                                      binaryName: providerBinaryName,
                                    })}
                              </span>
                            </label>

                            {providerSettings.homePathKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.homePathKey}`}
                                className="block"
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  {t("settings.providers.codexHomePath")}
                                </span>
                                <DebouncedSettingTextInput
                                  id={`provider-install-${providerSettings.homePathKey}`}
                                  size="sm"
                                  variant="soft"
                                  className="mt-1"
                                  value={codexHomePath}
                                  onCommit={(nextValue) =>
                                    updateSettings({
                                      codexHomePath: nextValue,
                                    })
                                  }
                                  placeholder="CODEX_HOME"
                                  spellCheck={false}
                                />
                                {providerSettings.homeDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {t("settings.providers.codexHomeDescription")}
                                  </span>
                                ) : null}
                              </label>
                            ) : null}

                            {providerSettings.agentDirKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.agentDirKey}`}
                                className="block"
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  {t("settings.providers.piAgentDir")}
                                </span>
                                <DebouncedSettingTextInput
                                  id={`provider-install-${providerSettings.agentDirKey}`}
                                  size="sm"
                                  variant="soft"
                                  className="mt-1"
                                  value={piAgentDir}
                                  onCommit={(nextValue) =>
                                    updateSettings({
                                      piAgentDir: nextValue,
                                    })
                                  }
                                  placeholder={t("settings.providers.piAgentDir")}
                                  spellCheck={false}
                                />
                                {providerSettings.agentDirDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {t("settings.providers.piAgentDirDescription")}
                                  </span>
                                ) : null}
                              </label>
                            ) : null}

                            {providerSettings.apiEndpointKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.apiEndpointKey}`}
                                className="block"
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  {t("settings.providers.cursorApiEndpoint")}
                                </span>
                                <DebouncedSettingTextInput
                                  id={`provider-install-${providerSettings.apiEndpointKey}`}
                                  size="sm"
                                  variant="soft"
                                  className="mt-1"
                                  value={cursorApiEndpoint}
                                  onCommit={(nextValue) =>
                                    updateSettings({
                                      cursorApiEndpoint: nextValue,
                                    })
                                  }
                                  placeholder={providerSettings.apiEndpointPlaceholder}
                                  spellCheck={false}
                                />
                                {providerSettings.apiEndpointDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {t("settings.providers.apiEndpointDescription", {
                                      binaryName: providerBinaryName,
                                    })}
                                  </span>
                                ) : null}
                              </label>
                            ) : null}

                            {providerSettings.serverUrlKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.serverUrlKey}`}
                                className="block"
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  {t("settings.providers.serverUrl", {
                                    title: providerSettings.title,
                                  })}
                                </span>
                                <DebouncedSettingTextInput
                                  id={`provider-install-${providerSettings.serverUrlKey}`}
                                  size="sm"
                                  variant="soft"
                                  className="mt-1"
                                  value={
                                    providerSettings.serverUrlKey === "kiloServerUrl"
                                      ? kiloServerUrl
                                      : openCodeServerUrl
                                  }
                                  onCommit={(nextValue) =>
                                    updateSettings(
                                      providerSettings.serverUrlKey === "kiloServerUrl"
                                        ? { kiloServerUrl: nextValue }
                                        : { openCodeServerUrl: nextValue },
                                    )
                                  }
                                  placeholder={providerSettings.serverUrlPlaceholder}
                                  spellCheck={false}
                                />
                                {providerSettings.serverUrlDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {t("settings.providers.serverUrlDescription", {
                                      title: providerSettings.title,
                                    })}
                                  </span>
                                ) : null}
                              </label>
                            ) : null}

                            {providerSettings.serverPasswordKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.serverPasswordKey}`}
                                className="block"
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  {t("settings.providers.serverPassword", {
                                    title: providerSettings.title,
                                  })}
                                </span>
                                <DebouncedSettingTextInput
                                  id={`provider-install-${providerSettings.serverPasswordKey}`}
                                  size="sm"
                                  variant="soft"
                                  className="mt-1"
                                  value={
                                    providerSettings.serverPasswordKey === "kiloServerPassword"
                                      ? kiloServerPassword
                                      : openCodeServerPassword
                                  }
                                  onCommit={(nextValue) =>
                                    updateSettings(
                                      providerSettings.serverPasswordKey === "kiloServerPassword"
                                        ? { kiloServerPassword: nextValue }
                                        : { openCodeServerPassword: nextValue },
                                    )
                                  }
                                  placeholder={t("settings.providers.serverPassword", {
                                    title: providerSettings.title,
                                  })}
                                  spellCheck={false}
                                />
                                {providerSettings.serverPasswordDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {t("settings.providers.serverPasswordDescription", {
                                      title: providerSettings.title,
                                    })}
                                  </span>
                                ) : null}
                              </label>
                            ) : null}

                            {providerSettings.experimentalWebSocketsKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.experimentalWebSocketsKey}`}
                                className="flex items-start justify-between gap-3 rounded-md border border-border/70 bg-background/60 px-3 py-2"
                              >
                                <span className="min-w-0">
                                  <span className="block text-xs font-medium text-foreground">
                                    {t("settings.providers.openaiResponseWebSockets")}
                                  </span>
                                  {providerSettings.experimentalWebSocketsDescription ? (
                                    <span className="mt-1 block text-xs text-muted-foreground">
                                      {t("settings.providers.openaiResponseWebSocketsDescription")}
                                    </span>
                                  ) : null}
                                </span>
                                <Switch
                                  id={`provider-install-${providerSettings.experimentalWebSocketsKey}`}
                                  checked={openCodeExperimentalWebSockets}
                                  onCheckedChange={(checked) =>
                                    updateSettings({
                                      openCodeExperimentalWebSockets: Boolean(checked),
                                    })
                                  }
                                />
                              </label>
                            ) : null}
                          </div>
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                );
              })}
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );

  const renderAdvancedPanel = () => (
    <div className="space-y-6">
      <SettingsSection title={t("settings.advanced.developerTools")}>
        <SettingsRow
          title={t("settings.advanced.keybindings")}
          description={t("settings.advanced.keybindingsDescription")}
          anchorId="setting-advanced-keybindings"
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? t("settings.advanced.resolvingKeybindingsPath")}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">{t("settings.advanced.opensInEditor")}</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings
                ? t("settings.advanced.opening")
                : t("settings.advanced.openFile")}
            </Button>
          }
        />

        <SettingsRow
          title={t("settings.advanced.recoveryTools")}
          description={t("settings.advanced.recoveryToolsDescription")}
          anchorId="setting-advanced-recovery-tools"
          status={
            shouldOfferRecoveryTools
              ? t("settings.advanced.recoveryVisibleReason")
              : t("settings.advanced.recoveryHiddenReason")
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!shouldOfferRecoveryTools || isRepairingLocalState}
              onClick={() => void repairLocalState()}
            >
              {isRepairingLocalState
                ? t("settings.advanced.repairing")
                : t("settings.advanced.repairState")}
            </Button>
          }
        >
          {shouldOfferRecoveryTools ? (
            <div className="mt-3 border-t border-border/70 pt-3">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left"
                onClick={() => setShowRecoveryTools((current) => !current)}
              >
                <span className="text-xs font-medium text-muted-foreground">
                  {t("settings.advanced.whatThisDoes")}
                </span>
                <ChevronDownIcon
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform",
                    showRecoveryTools && "rotate-180",
                  )}
                />
              </button>
              {showRecoveryTools ? (
                <div
                  className={cn(
                    "mt-3 px-3 py-3 text-xs text-muted-foreground",
                    SETTINGS_INSET_LIST_CLASS_NAME,
                  )}
                >
                  {t("settings.advanced.recoveryDetail")}
                </div>
              ) : null}
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("settings.advanced.about")}>
        <SettingsRow
          title={t("settings.advanced.version")}
          description={t("settings.advanced.versionDescription")}
          anchorId="setting-advanced-version"
          control={<code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>}
        />
        <SettingsRow
          title={t("settings.advanced.releaseHistory")}
          description={t("settings.advanced.releaseHistoryDescription")}
          anchorId="setting-advanced-release-history"
          control={
            <Button size="sm" variant="outline" onClick={() => setReleaseHistoryOpen(true)}>
              {t("settings.advanced.viewReleaseHistory")}
            </Button>
          }
        />
      </SettingsSection>
    </div>
  );

  const renderActivePanel = () => {
    switch (activeSection) {
      case "general":
        return renderGeneralPanel();
      case "appearance":
        return renderAppearancePanel();
      case "notifications":
        return renderNotificationsPanel();
      case "behavior":
        return renderBehaviorPanel();
      case "shortcuts":
        return <KeyboardShortcutsSettingsPanel />;
      case "worktrees":
        return renderWorktreesPanel();
      case "archived":
        return renderArchivedPanel();
      case "models":
        return renderModelsPanel();
      case "providers":
        return renderProvidersPanel();
      case "profile":
        return <ProfileSettingsPanel />;
      case "skills":
        return <SkillsSettingsPanel />;
      case "usage":
        return <ProviderUsageSettingsPanel />;
      case "advanced":
        return renderAdvancedPanel();
      default:
        return null;
    }
  };

  return (
    <div
      className={cn(
        CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
        SETTINGS_PAGE_BACKGROUND_CLASS_NAME,
        CHAT_CONTENT_CARD_CLASS_NAME,
      )}
    >
      <RouteInsetSurface surfaceClassName={SETTINGS_PAGE_BACKGROUND_CLASS_NAME}>
        {/* Companion sidebar trigger so settings is reachable-and-exitable even when the
          sidebar is collapsed (web/mobile have no global Back arrow). Pinned to the
          card's top-left — at the same header height + traffic-light gutter as the
          chat/workspace headers — so the collapsed-state toggle sits by the traffic
          lights instead of floating in the centered settings body. It renders nothing
          while the sidebar is open (SidebarHeaderNavigationControls returns null), so it
          adds no navigation chrome in the common (open) state and never shifts the centered
          content (hence absolute, not a layout-occupying header row). The strip stays a
          drag-region so the Windows frameless window can be moved by its top edge; the
          caption buttons themselves are a separate fixed cluster (see root route). */}
        <div
          className={cn(
            "drag-region absolute inset-x-0 top-0 z-10 flex items-center",
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            CHAT_SURFACE_HEADER_HEIGHT_CLASS,
            desktopTopBarTrafficLightGutterClassName,
          )}
        >
          <div className="pointer-events-auto">
            <SidebarHeaderNavigationControls />
          </div>
        </div>
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            {activeSection === "profile" ? (
              // Profile is a self-contained dashboard: it owns its own header (avatar,
              // name, share) so it skips the section title bar, and gets a slightly wider
              // pane than the form sections to fit the heatmap + two-column layout.
              <div className="mx-auto w-full max-w-3xl px-6 py-8">{renderActivePanel()}</div>
            ) : (
              <div className="mx-auto w-full max-w-2xl px-6 py-8">
                <div className="mb-8 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h1 className="text-xl font-medium tracking-tight text-foreground">
                      {t(activeSectionItem.labelKey)}
                    </h1>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      {t(activeSectionItem.descriptionKey)}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    className="shrink-0"
                    disabled={changedSettingLabels.length === 0}
                    onClick={() => void restoreDefaults()}
                  >
                    <RotateCcwIcon className="size-3.5" />
                    {t("settings.restoreDefaults")}
                  </Button>
                </div>

                {renderActivePanel()}
              </div>
            )}
          </div>
        </div>
        {/* Mounted at the route level (outside the scrollable panel) so the
          dialog portal can overlay the entire settings view without being
          clipped by the content wrapper's overflow. */}
        <ReleaseHistoryDialog
          open={releaseHistoryOpen}
          onOpenChange={setReleaseHistoryOpen}
          defaultExpandedVersion={APP_VERSION}
        />
      </RouteInsetSurface>
    </div>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
