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

const SIDEBAR_PROJECT_SORT_ORDER_LABELS = {
  updated_at: "Recently active",
  created_at: "Recently added",
  manual: "Manual order",
} as const;

const SIDEBAR_THREAD_SORT_ORDER_LABELS = {
  updated_at: "Recently active",
  created_at: "Newest first",
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
        onCheckedChange={(checked) => props.onHiddenChange(!Boolean(checked))}
        aria-label={`Show ${props.option.title} in the provider picker`}
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

function ProviderDocsLinks({ docs }: { docs: InstallProviderSettings["docs"] }) {
  return (
    <div className={cn(SETTINGS_INSET_LIST_CLASS_NAME, "px-3 py-2.5")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs font-medium text-foreground">CLI docs</span>
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
              <span>{doc.label}</span>
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

function providerUpdateStatusLabel(provider: ServerProviderStatus): string | null {
  const state = provider.updateState?.status;
  if (state === "queued") {
    return "Update queued";
  }
  if (state === "running") {
    return "Updating";
  }
  if (state === "succeeded") {
    return "Updated";
  }
  if (state === "failed") {
    return "Update failed";
  }
  if (state === "unchanged") {
    return "Still outdated";
  }
  const advisory = provider.versionAdvisory;
  if (advisory?.status === "behind_latest" && advisory.latestVersion) {
    const currentVersion = formatProviderVersion(advisory.currentVersion);
    const latestVersion = formatProviderVersion(advisory.latestVersion);
    return currentVersion ? `${currentVersion} -> ${latestVersion}` : `Latest ${latestVersion}`;
  }
  const currentVersion = formatProviderVersion(provider.version);
  return currentVersion ? `Current ${currentVersion}` : null;
}

function providerUpdateFailureMessage(provider: ServerProviderStatus | undefined): string | null {
  const state = provider?.updateState;
  if (!state || (state.status !== "failed" && state.status !== "unchanged")) {
    return null;
  }
  return state.output?.trim() || state.message || "The provider update did not complete.";
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
    ...(theme !== "system" ? ["Theme"] : []),
    ...(!isDefaultActiveTheme ? [`${resolvedTheme === "dark" ? "Dark" : "Light"} theme pack`] : []),
    ...(settings.defaultProvider !== defaults.defaultProvider ? ["Default provider"] : []),
    ...(settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? ["New thread mode"] : []),
    ...(settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder
      ? ["Project sort order"]
      : []),
    ...(settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder
      ? ["Thread sort order"]
      : []),
    ...(settings.showChatsSection !== defaults.showChatsSection ? ["Chats section"] : []),
    ...(settings.showWorkspaceSection !== defaults.showWorkspaceSection
      ? ["Workspace section"]
      : []),
    ...(settings.uiDensity !== defaults.uiDensity ? ["UI density"] : []),
    ...(settings.chatFontSizePx !== defaults.chatFontSizePx ? ["Base font size"] : []),
    ...(settings.terminalFontSizePx !== defaults.terminalFontSizePx ? ["Terminal font size"] : []),
    ...(settings.terminalFontFamily !== defaults.terminalFontFamily ? ["Terminal font"] : []),
    ...(shouldShowFontSmoothing &&
    settings.enableNativeFontSmoothing !== defaults.enableNativeFontSmoothing
      ? ["Font smoothing"]
      : []),
    ...(settings.timestampFormat !== defaults.timestampFormat ? ["Time format"] : []),
    ...(settings.enableTaskCompletionToasts !== defaults.enableTaskCompletionToasts
      ? ["Activity toasts"]
      : []),
    ...(settings.enableSystemTaskCompletionNotifications !==
    defaults.enableSystemTaskCompletionNotifications
      ? ["Desktop notifications"]
      : []),
    ...(settings.enableAssistantStreaming !== defaults.enableAssistantStreaming
      ? ["Assistant output"]
      : []),
    ...(settings.enableProviderUpdateChecks !== defaults.enableProviderUpdateChecks
      ? ["Provider update checks"]
      : []),
    ...(settings.diffWordWrap !== defaults.diffWordWrap ? ["Diff line wrapping"] : []),
    ...(settings.confirmThreadDelete !== defaults.confirmThreadDelete
      ? ["Delete confirmation"]
      : []),
    ...(settings.confirmThreadArchive !== defaults.confirmThreadArchive
      ? ["Archive confirmation"]
      : []),
    ...(settings.confirmTerminalTabClose !== defaults.confirmTerminalTabClose
      ? ["Terminal close confirmation"]
      : []),
    ...(isGitTextGenerationModelDirty ? ["Git writing model"] : []),
    ...(settings.customCodexModels.length > 0 ||
    settings.customClaudeModels.length > 0 ||
    settings.customCursorModels.length > 0 ||
    settings.customGeminiModels.length > 0 ||
    settings.customGrokModels.length > 0 ||
    settings.customKiloModels.length > 0 ||
    settings.customOpenCodeModels.length > 0 ||
    settings.customPiModels.length > 0
      ? ["Custom models"]
      : []),
    ...(isInstallSettingsDirty ? ["Provider installs"] : []),
    ...(hiddenProviderCount > 0 ? ["Provider visibility"] : []),
    ...(isProviderOrderDirty ? ["Provider order"] : []),
  ];

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void api.shell
      .openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
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
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
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
        const failureMessage = providerUpdateFailureMessage(refreshedProvider);
        if (failureMessage) {
          const manualCommand = refreshedProvider?.versionAdvisory?.updateCommand?.trim();
          toastManager.add({
            type: "error",
            title: `Could not update ${PROVIDER_DISPLAY_NAMES[provider]}`,
            description: manualCommand
              ? `${failureMessage}\n\nCopy the command below to update manually in a terminal.`
              : failureMessage,
            ...(manualCommand ? { data: { copyText: manualCommand } } : {}),
          });
          return;
        }
        toastManager.add({
          type: "success",
          title: `${PROVIDER_DISPLAY_NAMES[provider]} update finished`,
          description: "New sessions will use the refreshed provider.",
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Could not update ${PROVIDER_DISPLAY_NAMES[provider]}`,
          description: error instanceof Error ? error.message : "The provider update failed.",
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
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
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
      title: "Desktop notifications unavailable",
      description: buildNotificationSettingsSupportText(permission),
    });
  }

  async function sendTestNotification() {
    const title = "Activity notification";
    const body = "Notification test for chats and terminal agents.";

    if (window.desktopBridge) {
      const shown = await window.desktopBridge.notifications.show({ title, body, silent: false });
      toastManager.add({
        type: shown ? "success" : "warning",
        title: shown ? "Test notification sent" : "Notifications unavailable",
        description: shown
          ? "Your operating system should show the notification."
          : "Desktop notifications are not supported on this device.",
      });
      return;
    }

    const permission = await requestBrowserNotificationPermission();
    setBrowserNotificationPermission(permission);
    if (permission !== "granted") {
      toastManager.add({
        type: permission === "denied" ? "warning" : "error",
        title: "Desktop notifications unavailable",
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
      title: "Test notification sent",
      description: "Your browser should show the notification.",
    });
  }

  // Rebuild the local project indexes after an older install leaves them out of sync.
  const repairLocalState = useCallback(async () => {
    if (isRepairingLocalState) {
      return;
    }

    const api = readNativeApi() ?? ensureNativeApi();
    const confirmed = await api.dialogs.confirm(
      [
        "Repair local state?",
        "This rebuilds local project indexes and refreshes project snapshots.",
        "It keeps existing chats in place, but it may take a moment.",
      ].join("\n"),
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
        title: "Local state repaired",
        description: "Project indexes were rebuilt without clearing existing chats.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Repair failed",
        description: error instanceof Error ? error.message : "Unable to repair local state.",
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
          title: "Could not verify linked conversations",
          description: "Retry once the app reconnects to the server.",
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
              `Delete worktree "${displayName}"?`,
              "",
              `${linkedActiveThreadCount} active and ${linkedArchivedThreadIds.length} archived ${pluralize(linkedConversationCount, "conversation is", "conversations are")} linked to this worktree.`,
              linkedArchivedThreadIds.length > 0
                ? "Archived conversations will be deleted first."
                : "Deleting it can break reopening those chats in the same workspace.",
              "",
              "Delete the worktree anyway?",
            ].join("\n")
          : [`Delete worktree "${displayName}"?`, "This removes the Git worktree from disk."].join(
              "\n",
            ),
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
          title: "Worktree deleted",
          description:
            linkedArchivedThreadIds.length > 0
              ? `${displayName} was removed and ${linkedArchivedThreadIds.length} archived ${pluralize(linkedArchivedThreadIds.length, "conversation")} were deleted.`
              : `${displayName} was removed.`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete worktree",
          description: error instanceof Error ? error.message : "Unable to delete the worktree.",
        });
      }
    },
    [queryClient, removeDeletedThreadFromClientState, removeWorktreeMutation],
  );

  const unarchiveThread = useCallback(async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    try {
      await unarchiveThreadFromClient(api.orchestration, threadId);
      toastManager.add({
        type: "success",
        title: "Thread restored",
        description: "The thread has been moved back to the sidebar.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not restore thread",
        description: error instanceof Error ? error.message : "Unable to restore the thread.",
      });
    }
  }, []);

  const deleteArchivedThread = useCallback(
    async (threadId: ThreadId, threadTitle: string) => {
      const api = readNativeApi();
      if (!api) return;

      const confirmed = await api.dialogs.confirm(
        `Permanently delete "${threadTitle}"?\n\nThis will remove the thread and its conversation history forever.`,
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
          title: "Thread deleted",
          description: "The archived thread has been permanently removed.",
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete thread",
          description: error instanceof Error ? error.message : "Unable to delete the thread.",
        });
      }
    },
    [removeDeletedThreadFromClientState],
  );

  const handleArchivedThreadContextMenu = useCallback(
    async (threadId: ThreadId, threadTitle: string, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;

      const clicked = await api.contextMenu.show(
        [
          { id: "restore", label: "Restore" },
          { id: "delete", label: "Delete", destructive: true },
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
  }) => {
    const { settingKey, title, description, resetLabel, ariaLabel } = config;
    const isChanged = settings[settingKey] !== defaults[settingKey];
    return (
      <SettingsRow
        title={title}
        description={description}
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
      <SettingsSection title="Core defaults">
        <SettingsRow
          title="Default provider"
          description="Choose the provider used for new chats."
          resetAction={
            settings.defaultProvider !== defaults.defaultProvider ? (
              <SettingResetButton
                label="default provider"
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
              ariaLabel="Default provider"
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
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
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
              ariaLabel="Default thread mode"
              valueContent={settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
            >
              <SelectItem hideIndicator value="local">
                Local
              </SelectItem>
              <SelectItem hideIndicator value="worktree">
                New worktree
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>

      <SettingsSection title="Sidebar organization">
        <SettingsRow
          title="Project order"
          description="Controls how projects are arranged in the main sidebar."
          resetAction={
            settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder ? (
              <SettingResetButton
                label="project order"
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
              ariaLabel="Project sort order"
              valueContent={SIDEBAR_PROJECT_SORT_ORDER_LABELS[settings.sidebarProjectSortOrder]}
            >
              <SelectItem hideIndicator value="updated_at">
                {SIDEBAR_PROJECT_SORT_ORDER_LABELS.updated_at}
              </SelectItem>
              <SelectItem hideIndicator value="created_at">
                {SIDEBAR_PROJECT_SORT_ORDER_LABELS.created_at}
              </SelectItem>
              <SelectItem hideIndicator value="manual">
                {SIDEBAR_PROJECT_SORT_ORDER_LABELS.manual}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        <SettingsRow
          title="Thread order"
          description="Controls how threads are arranged inside each project in the main sidebar."
          resetAction={
            settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder ? (
              <SettingResetButton
                label="thread order"
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
              ariaLabel="Thread sort order"
              valueContent={SIDEBAR_THREAD_SORT_ORDER_LABELS[settings.sidebarThreadSortOrder]}
            >
              <SelectItem hideIndicator value="updated_at">
                {SIDEBAR_THREAD_SORT_ORDER_LABELS.updated_at}
              </SelectItem>
              <SelectItem hideIndicator value="created_at">
                {SIDEBAR_THREAD_SORT_ORDER_LABELS.created_at}
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>

      <SettingsSection title="Sidebar sections">
        {renderBooleanSettingRow({
          settingKey: "showChatsSection",
          title: "Chats",
          description:
            "Show the standalone Chats list in the sidebar footer (chats not tied to a project).",
          resetLabel: "chats section",
          ariaLabel: "Show the Chats section in the sidebar",
        })}

        {renderBooleanSettingRow({
          settingKey: "showWorkspaceSection",
          title: "Workspace",
          description:
            "Show the Workspace tab in the sidebar switcher. The Threads tab always stays visible.",
          resetLabel: "workspace section",
          ariaLabel: "Show the Workspace section in the sidebar",
        })}
      </SettingsSection>

      <div ref={environmentPanelRef} id={SETTINGS_TARGETS.environmentPanel}>
        <SettingsSection title="Environment panel">
          {renderBooleanSettingRow({
            settingKey: "showEnvironmentUsage",
            title: "Usage",
            description: "Show the provider usage row in the chat Environment panel.",
            resetLabel: "usage section",
            ariaLabel: "Show the Usage section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentRepository",
            title: "Repository",
            description:
              "Show the GitHub repository link in the chat Environment panel. The git block (Changes, Worktree, branch, Commit and Push) always stays visible.",
            resetLabel: "repository section",
            ariaLabel: "Show the Repository section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentEditor",
            title: "Editor",
            description:
              "Show the Editor section (in-app editor view and Open in editor picker) in the chat Environment panel.",
            resetLabel: "editor section",
            ariaLabel: "Show the Editor section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentRecap",
            title: "Recap",
            description: "Show the auto-generated chat recap in the Environment panel.",
            resetLabel: "recap section",
            ariaLabel: "Show the Recap section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentPinned",
            title: "Pinned messages",
            description: "Show the pinned-messages checklist in the Environment panel.",
            resetLabel: "pinned messages section",
            ariaLabel: "Show the Pinned messages section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentMarkers",
            title: "Text markers",
            description:
              "Show highlighted and underlined transcript text in the Environment panel.",
            resetLabel: "text markers section",
            ariaLabel: "Show the Text markers section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentInstructions",
            title: "Project instructions",
            description: "Show project-level instructions in the Environment panel.",
            resetLabel: "project instructions section",
            ariaLabel: "Show the Project instructions section in the Environment panel",
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentNotepad",
            title: "Notepad",
            description: "Show the per-thread notepad in the Environment panel.",
            resetLabel: "notepad section",
            ariaLabel: "Show the Notepad section in the Environment panel",
          })}
        </SettingsSection>
      </div>
    </div>
  );

  const renderAppearancePanel = () => (
    <div className="space-y-6">
      <section className={SETTINGS_PANEL_SECTION_CLASS_NAME}>
        <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>Theme and typography</h2>
        <SettingsCard>
          <SettingsRow
            title="Theme"
            description="Choose how Synara looks across the app."
            resetAction={
              theme !== "system" ? (
                <SettingResetButton label="theme" onClick={() => setTheme("system")} />
              ) : null
            }
            control={
              <SettingsSegmentedControl
                value={theme}
                onValueChange={(value) => {
                  if (value !== "system" && value !== "light" && value !== "dark") return;
                  setTheme(value);
                }}
                ariaLabel="Theme preference"
                options={THEME_OPTIONS}
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
            title="UI density"
            description="Control spacing in the sidebar, composer, chat gutters, and settings rows without changing font size."
            resetAction={
              settings.uiDensity !== defaults.uiDensity ? (
                <SettingResetButton
                  label="UI density"
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
                ariaLabel="UI density"
                options={UI_DENSITY_OPTIONS}
              />
            }
          />

          <SettingsRow
            title="Base font size"
            description="Adjust the app text base in pixels. Chat and UI typography scale proportionally from this value."
            resetAction={
              settings.chatFontSizePx !== defaults.chatFontSizePx ? (
                <SettingResetButton
                  label="base font size"
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
                  aria-label="Base font size in pixels"
                />
                <span className="text-xs text-muted-foreground">px</span>
              </div>
            }
          />

          <SettingsRow
            title="Terminal font size"
            description="Adjust terminal text independently from the app and chat font size."
            resetAction={
              settings.terminalFontSizePx !== defaults.terminalFontSizePx ? (
                <SettingResetButton
                  label="terminal font size"
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
                  aria-label="Terminal font size in pixels"
                />
                <span className="text-xs text-muted-foreground">px</span>
              </div>
            }
          />

          <SettingsRow
            title="Terminal font"
            description="Type any monospace font installed on this device (e.g. Fira Code). Leave empty for the default. Fonts that aren't installed fall back to the system monospace."
            resetAction={
              settings.terminalFontFamily !== defaults.terminalFontFamily ? (
                <SettingResetButton
                  label="terminal font"
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
                    placeholder="Default (JetBrains Mono)"
                    className="w-full sm:w-56"
                    aria-label="Terminal font family"
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
                      <AutocompleteEmpty>No matching suggested fonts.</AutocompleteEmpty>
                    </AutocompleteList>
                  </AutocompletePopup>
                </Autocomplete>
              </div>
            }
          />

          {shouldShowFontSmoothing
            ? renderBooleanSettingRow({
                settingKey: "enableNativeFontSmoothing",
                title: "Font smoothing",
                description: "Use macOS-style antialiasing for lighter, crisper text rendering.",
                resetLabel: "font smoothing",
                ariaLabel: "Enable font smoothing",
              })
            : null}
        </SettingsCard>
      </section>

      <SettingsSection title="Time and reading">
        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== defaults.timestampFormat ? (
              <SettingResetButton
                label="time format"
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
              ariaLabel="Timestamp format"
              triggerClassName="w-full sm:w-40"
              valueContent={TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}
            >
              <SelectItem hideIndicator value="locale">
                {TIMESTAMP_FORMAT_LABELS.locale}
              </SelectItem>
              <SelectItem hideIndicator value="12-hour">
                {TIMESTAMP_FORMAT_LABELS["12-hour"]}
              </SelectItem>
              <SelectItem hideIndicator value="24-hour">
                {TIMESTAMP_FORMAT_LABELS["24-hour"]}
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>
    </div>
  );

  const renderNotificationsPanel = () => (
    <div className="space-y-6">
      <SettingsSection title="Activity alerts">
        {renderBooleanSettingRow({
          settingKey: "enableTaskCompletionToasts",
          title: "Activity toasts",
          description:
            "Show an in-app toast when a chat or managed terminal agent finishes or needs input.",
          resetLabel: "activity toasts",
          ariaLabel: "Activity toast notifications",
        })}

        <SettingsRow
          title="Desktop notifications"
          description="Show an OS notification when a chat or managed terminal agent finishes or needs input while the app is in the background."
          status={buildNotificationSettingsSupportText(browserNotificationPermission)}
          resetAction={
            settings.enableSystemTaskCompletionNotifications !==
            defaults.enableSystemTaskCompletionNotifications ? (
              <SettingResetButton
                label="desktop notifications"
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
                Test
              </Button>
              <Switch
                checked={settings.enableSystemTaskCompletionNotifications}
                onCheckedChange={(checked) => {
                  void setSystemNotificationsEnabled(Boolean(checked));
                }}
                aria-label="Desktop activity notifications"
              />
            </div>
          }
        />
      </SettingsSection>
    </div>
  );

  const renderBehaviorPanel = () => (
    <div className="space-y-6">
      <SettingsSection title="Runtime behavior">
        {renderBooleanSettingRow({
          settingKey: "enableAssistantStreaming",
          title: "Assistant output",
          description: "Show token-by-token output while a response is in progress.",
          resetLabel: "assistant output",
          ariaLabel: "Stream assistant messages",
        })}

        {renderBooleanSettingRow({
          settingKey: "diffWordWrap",
          title: "Diff line wrapping",
          description:
            "Set the default wrap state when the diff panel opens. The in-panel wrap toggle only affects the current diff session.",
          resetLabel: "diff line wrapping",
          ariaLabel: "Wrap diff lines by default",
        })}
      </SettingsSection>

      <SettingsSection title="Safety confirmations">
        {renderBooleanSettingRow({
          settingKey: "confirmThreadDelete",
          title: "Delete confirmation",
          description: "Ask before deleting a thread and its chat history.",
          resetLabel: "delete confirmation",
          ariaLabel: "Confirm thread deletion",
        })}

        {renderBooleanSettingRow({
          settingKey: "confirmThreadArchive",
          title: "Archive confirmation",
          description: "Ask before archiving a thread.",
          resetLabel: "archive confirmation",
          ariaLabel: "Confirm thread archive",
        })}

        {renderBooleanSettingRow({
          settingKey: "confirmTerminalTabClose",
          title: "Terminal close confirmation",
          description: "Ask before closing a terminal tab and clearing its history.",
          resetLabel: "terminal close confirmation",
          ariaLabel: "Confirm terminal tab close",
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
          Loading managed worktrees...
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
            : "Unable to load worktrees."}
        </div>
      );
    }
    if (worktreesByWorkspaceRoot.length === 0) {
      return (
        <div
          className={cn(SETTINGS_EMPTY_STATE_CLASS_NAME, "px-4 py-6 text-sm text-muted-foreground")}
        >
          No app-managed worktrees found yet.
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
                        <div className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>Worktree</div>
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
                          Conversations
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
                            No conversations linked to this worktree.
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
                        Delete
                      </Button>
                      {worktree.linkedThreads.length > 0 ? (
                        <p
                          className={cn(
                            SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
                            "max-w-40 text-right",
                          )}
                        >
                          Linked conversations exist. Deleting will ask for confirmation.
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
          <div className="text-sm font-medium text-foreground">No archived threads</div>
          <div className="mt-1 text-sm text-muted-foreground">
            Archived threads will appear here and can be restored to the sidebar.
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
            title={project?.name ?? "Unknown project"}
          >
            {projectThreads.map((thread) => (
              <SettingsListRow
                key={thread.id}
                title={thread.title}
                description={`Archived ${formatRelativeTime(thread.archivedAt ?? thread.createdAt)}`}
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
                      Restore
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      onClick={() => void deleteArchivedThread(thread.id, thread.title)}
                    >
                      Delete
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
      <SettingsSection title="Generation defaults">
        <SettingsRow
          title="Git writing model"
          description="Used for generated commit messages, PR titles, and branch names."
          resetAction={
            isGitTextGenerationModelDirty ? (
              <SettingResetButton
                label="git writing model"
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
              ariaLabel="Git text generation model"
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

      <SettingsSection title="Custom models">
        <SettingsRow
          title="Saved model slugs"
          description="Add custom model slugs for supported providers."
          resetAction={
            totalCustomModels > 0 ? (
              <SettingResetButton
                label="custom models"
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
                  aria-label="Custom model provider"
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
                Add
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
                      aria-label={`Remove ${row.slug}`}
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
                      ? "Show less"
                      : `Show more (${savedCustomModelRows.length - 5})`}
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
      <SettingsSection title="Provider picker">
        <SettingsRow
          title="Visible providers"
          description="Drag providers into your preferred picker order and hide the ones you don't use. The provider you're currently using on a thread always stays visible."
          status={
            hiddenProviderCount > 0
              ? `${hiddenProviderCount} ${pluralize(hiddenProviderCount, "provider")} hidden`
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
      <SettingsSection title="Updates">
        {renderBooleanSettingRow({
          settingKey: "enableProviderUpdateChecks",
          title: "Automatic CLI update checks",
          description:
            "Check Codex, Claude, and other provider CLIs for newer versions in the background.",
          resetLabel: "CLI update checks",
          ariaLabel: "Automatic CLI update checks",
        })}

        <SettingsRow
          title="Provider updates"
          description="Review installed provider tools that Synara can safely update."
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
                const updateLabel = providerUpdateStatusLabel(providerStatus);

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
                              ? `Run ${updateAdvisory.updateCommand}`
                              : undefined
                          }
                          onClick={() => void runProviderUpdate(providerStatus.provider)}
                        >
                          {isProviderUpdateActive ? (
                            <Loader2Icon className="size-3.5 animate-spin" />
                          ) : (
                            <DownloadIcon className="size-3.5" />
                          )}
                          {isProviderUpdateActive ? "Updating" : "Update"}
                        </Button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">Manual update</span>
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
      <SettingsSection title="Provider tools">
        <SettingsRow
          title="Installed CLIs"
          description="Review provider versions and update tools. Open a row only when you need binary overrides."
          status={
            !settings.enableProviderUpdateChecks
              ? "Automatic checks off"
              : outdatedProviderCount > 0
                ? `${outdatedProviderCount} ${pluralize(outdatedProviderCount, "update")} available`
                : "No provider updates detected"
          }
          resetAction={
            isInstallSettingsDirty ? (
              <SettingResetButton
                label="provider tools"
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
                      ? `Current ${currentProviderVersion}`
                      : null
                    : providerUpdateSuppressed
                      ? null
                      : providerUpdateStatusLabel(providerStatus)
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
                              Custom
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
                                ? `Run ${updateAdvisory.updateCommand}`
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
                            {isProviderUpdateActive ? "Updating" : "Update"}
                          </Button>
                        ) : null}
                      </div>

                      <CollapsibleContent>
                        <div className="border-t border-border/70 bg-muted/20 px-3 py-3">
                          <div className="space-y-3">
                            <ProviderDocsLinks docs={providerSettings.docs} />
                            {showProviderUpdateStatus &&
                            updateAdvisory?.status === "behind_latest" ? (
                              <div className="text-xs text-muted-foreground">
                                {updateAdvisory.canUpdate && updateAdvisory.updateCommand ? (
                                  <>
                                    <span>Command: </span>
                                    <code className="font-mono">
                                      {updateAdvisory.updateCommand}
                                    </code>
                                  </>
                                ) : (
                                  "A newer version is available, but Synara could not identify a safe one-click update command for this installation."
                                )}
                              </div>
                            ) : null}

                            <label
                              htmlFor={`provider-install-${providerSettings.binaryPathKey}`}
                              className="block"
                            >
                              <span className="block text-xs font-medium text-foreground">
                                {providerSettings.title} binary path
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
                                placeholder={providerSettings.binaryPlaceholder}
                                spellCheck={false}
                              />
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {providerSettings.binaryDescription}
                              </span>
                            </label>

                            {providerSettings.homePathKey ? (
                              <label
                                htmlFor={`provider-install-${providerSettings.homePathKey}`}
                                className="block"
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  CODEX_HOME path
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
                                  placeholder={providerSettings.homePlaceholder}
                                  spellCheck={false}
                                />
                                {providerSettings.homeDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {providerSettings.homeDescription}
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
                                  Pi agent directory
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
                                  placeholder={providerSettings.agentDirPlaceholder}
                                  spellCheck={false}
                                />
                                {providerSettings.agentDirDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {providerSettings.agentDirDescription}
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
                                  Cursor API endpoint
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
                                    {providerSettings.apiEndpointDescription}
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
                                  {providerSettings.title} server URL
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
                                    {providerSettings.serverUrlDescription}
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
                                  {providerSettings.title} server password
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
                                  placeholder={providerSettings.serverPasswordPlaceholder}
                                  spellCheck={false}
                                />
                                {providerSettings.serverPasswordDescription ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {providerSettings.serverPasswordDescription}
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
                                    OpenAI response WebSockets
                                  </span>
                                  {providerSettings.experimentalWebSocketsDescription ? (
                                    <span className="mt-1 block text-xs text-muted-foreground">
                                      {providerSettings.experimentalWebSocketsDescription}
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
      <SettingsSection title="Developer tools">
        <SettingsRow
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
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
              {isOpeningKeybindings ? "Opening..." : "Open file"}
            </Button>
          }
        />

        <SettingsRow
          title="Recovery tools"
          description="Rebuild local project indexes without clearing existing chats when the local state gets out of sync."
          status={
            shouldOfferRecoveryTools
              ? "Visible because projects exist but no chat history is currently available."
              : "Shown automatically only when recovery actions are relevant."
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!shouldOfferRecoveryTools || isRepairingLocalState}
              onClick={() => void repairLocalState()}
            >
              {isRepairingLocalState ? "Repairing..." : "Repair state"}
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
                <span className="text-xs font-medium text-muted-foreground">What this does</span>
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
                  Rebuilds local project indexes and refreshes project snapshots. Existing chats
                  stay in place.
                </div>
              ) : null}
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="About">
        <SettingsRow
          title="Version"
          description="Current application version."
          control={<code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>}
        />
        <SettingsRow
          title="Release history"
          description="A running log of every update, newest first. Same notes the post-update dialog shows, kept here so you can revisit them any time."
          control={
            <Button size="sm" variant="outline" onClick={() => setReleaseHistoryOpen(true)}>
              View release history
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
                      {activeSectionItem.label}
                    </h1>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      {activeSectionItem.description}
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
                    Restore defaults
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
