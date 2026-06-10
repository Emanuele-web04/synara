// FILE: _chat.settings.tsx
// Purpose: Render the dedicated settings experience with its own section sidebar and grouped panels.
// Layer: Route screen
// Exports: Settings route component for `/settings`

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ThreadId,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
} from "@t3tools/contracts";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import {
  getCustomModelsForProvider,
  MAX_CUSTOM_MODEL_LENGTH,
  patchCustomModels,
  useAppSettings,
} from "../appSettings";
import { APP_VERSION } from "../branding";
import { useDesktopTopBarTrafficLightGutterClassName } from "../hooks/useDesktopTopBarGutter";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { NotificationsSettings } from "../components/settings/NotificationsSettings";
import { BehaviorSettings } from "../components/settings/BehaviorSettings";
import { AppearanceSettings } from "../components/settings/AppearanceSettings";
import { GeneralSettings } from "../components/settings/GeneralSettings";
import { SandboxesSettings } from "../components/settings/SandboxesSettings";
import { WorktreesSettings } from "../components/settings/WorktreesSettings";
import { AdvancedSettings } from "../components/settings/AdvancedSettings";
import { ArchivedThreadsSettings } from "../components/settings/ArchivedThreadsSettings";
import { ModelsSettings } from "../components/settings/ModelsSettings";
import {
  ProvidersSettings,
  providerUpdateFailureMessage,
} from "../components/settings/ProvidersSettings";
import {
  CHAT_CONTENT_CARD_CLASS_NAME,
  CHAT_ROUTE_INSET_SHELL_CLASS_NAME,
} from "../components/chat/composerPickerStyles";
import { CHAT_SURFACE_HEADER_HEIGHT_CLASS } from "../components/chat/chatHeaderControls";
import { SidebarHeaderNavigationControls } from "../components/SidebarHeaderNavigationControls";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { gitRemoveWorktreeMutationOptions } from "../lib/gitReactQuery";
import { RotateCcwIcon } from "../lib/icons";
import {
  serverConfigQueryOptions,
  serverQueryKeys,
  serverWorktreesQueryOptions,
} from "../lib/serverReactQuery";
import { cn, isMacPlatform } from "../lib/utils";
import { newCommandId } from "../lib/utils";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import {
  buildNotificationSettingsSupportText,
  readBrowserNotificationPermissionState,
  requestBrowserNotificationPermission,
} from "../notifications/taskCompletion";
import { SANDBOX_APP_SETTINGS_KEYS } from "../sandboxSettings";
import { normalizeSettingsSection, SETTINGS_NAV_ITEMS } from "../settingsNavigation";
import { SETTINGS_PAGE_BACKGROUND_CLASS_NAME } from "../settingsPanelStyles";
import { useStore } from "../store";
import ReleaseHistoryDialog from "../components/ReleaseHistoryDialog";
import { createAllThreadsSelector } from "../storeSelectors";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { sameProviderOrder } from "../providerOrdering";

// ── Settings taxonomy ──────────────────────────────────────────────────────

function normalizeManagedWorktreePath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// ── Route screen ───────────────────────────────────────────────────────────

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
  const serverWorktreesQuery = useQuery(serverWorktreesQueryOptions());
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const threads = useStore(useMemo(() => createAllThreadsSelector(), []));
  const projects = useStore((store) => store.projects);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const archivedThreads = threads.filter((thread) => thread.archivedAt != null);
  const shouldOfferRecoveryTools = useMemo(() => {
    if (!threadsHydrated || projects.length === 0) {
      return false;
    }
    return threads.every((thread) => thread.messages.length === 0);
  }, [projects.length, threads, threadsHydrated]);

  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [isRepairingLocalState, setIsRepairingLocalState] = useState(false);
  const [releaseHistoryOpen, setReleaseHistoryOpen] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const providerUpdatesRef = useRef<HTMLDivElement | null>(null);
  const providerInstallsRef = useRef<HTMLDivElement | null>(null);
  const [openInstallProviders, setOpenInstallProviders] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(settings.codexBinaryPath || settings.codexHomePath),
    claudeAgent: Boolean(settings.claudeBinaryPath),
    cursor: Boolean(settings.cursorBinaryPath || settings.cursorApiEndpoint),
    gemini: Boolean(settings.geminiBinaryPath),
    grok: Boolean(settings.grokBinaryPath),
    kilo: Boolean(settings.kiloBinaryPath || settings.kiloServerUrl || settings.kiloServerPassword),
    opencode: Boolean(
      settings.openCodeBinaryPath || settings.openCodeServerUrl || settings.openCodeServerPassword,
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

  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const hiddenProviderCount = hiddenProviderSet.size;
  const isProviderOrderDirty = !sameProviderOrder(settings.providerOrder, defaults.providerOrder);
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = serverConfigQuery.data?.availableEditors;
  const providerStatusByProvider = useMemo(
    () =>
      new Map((serverConfigQuery.data?.providers ?? []).map((status) => [status.provider, status])),
    [serverConfigQuery.data?.providers],
  );
  const outdatedProviderCount = useMemo(
    () =>
      (serverConfigQuery.data?.providers ?? []).filter(
        (status) => status.versionAdvisory?.status === "behind_latest",
      ).length,
    [serverConfigQuery.data?.providers],
  );
  const outdatedProviderStatuses = useMemo(
    () =>
      (serverConfigQuery.data?.providers ?? []).filter(
        (status) => status.versionAdvisory?.status === "behind_latest",
      ),
    [serverConfigQuery.data?.providers],
  );
  const shouldFocusProviderUpdates =
    activeSection === "providers" && settingsTarget === "provider-updates";

  useEffect(() => {
    if (!shouldFocusProviderUpdates) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      providerUpdatesRef.current?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [serverConfigQuery.data?.providers, shouldFocusProviderUpdates]);
  const managedWorktrees = serverWorktreesQuery.data?.worktrees ?? [];
  const worktreesByWorkspaceRoot = managedWorktrees.reduce<
    Array<{
      workspaceRoot: string;
      worktrees: Array<{
        path: string;
        linkedThreads: typeof threads;
      }>;
    }>
  >((groups, worktree) => {
    const linkedThreads = threads.filter((thread) => {
      const candidatePaths = [
        normalizeManagedWorktreePath(thread.worktreePath),
        normalizeManagedWorktreePath(thread.associatedWorktreePath),
      ];
      return candidatePaths.includes(worktree.path);
    });
    const existingGroup = groups.find((group) => group.workspaceRoot === worktree.workspaceRoot);
    const nextWorktree = {
      path: worktree.path,
      linkedThreads,
    };
    if (existingGroup) {
      existingGroup.worktrees.push(nextWorktree);
    } else {
      groups.push({
        workspaceRoot: worktree.workspaceRoot,
        worktrees: [nextWorktree],
      });
    }
    return groups;
  }, []);

  const currentGitTextGenerationProvider = settings.textGenerationProvider ?? "codex";
  const currentGitTextGenerationModel =
    settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
  const defaultGitTextGenerationProvider = defaults.textGenerationProvider ?? "codex";
  const defaultGitTextGenerationModel =
    defaults.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
  const isGitTextGenerationModelDirty =
    currentGitTextGenerationProvider !== defaultGitTextGenerationProvider ||
    currentGitTextGenerationModel !== defaultGitTextGenerationModel;
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
    settings.openCodeServerUrl !== defaults.openCodeServerUrl ||
    settings.openCodeServerPassword !== defaults.openCodeServerPassword ||
    settings.piBinaryPath !== defaults.piBinaryPath ||
    settings.piAgentDir !== defaults.piAgentDir;

  const isSandboxSettingsDirty = SANDBOX_APP_SETTINGS_KEYS.some(
    (key) => settings[key] !== defaults[key],
  );

  const changedSettingLabels = [
    ...(theme !== "system" ? ["Theme"] : []),
    ...(!isDefaultActiveTheme ? [`${resolvedTheme === "dark" ? "Dark" : "Light"} theme pack`] : []),
    ...(settings.defaultProvider !== defaults.defaultProvider ? ["Default provider"] : []),
    ...(settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? ["New thread mode"] : []),
    ...(settings.sidebarSide !== defaults.sidebarSide ? ["Sidebar position"] : []),
    ...(settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder
      ? ["Project sort order"]
      : []),
    ...(settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder
      ? ["Thread sort order"]
      : []),
    ...(settings.uiFontFamily !== defaults.uiFontFamily ? ["UI font"] : []),
    ...(settings.chatCodeFontFamily !== defaults.chatCodeFontFamily ? ["Code font"] : []),
    ...(settings.chatFontSizePx !== defaults.chatFontSizePx ? ["Base font size"] : []),
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
    ...(settings.diffWordWrap !== defaults.diffWordWrap ? ["Diff line wrapping"] : []),
    ...(settings.enableComposerSuggestions !== defaults.enableComposerSuggestions
      ? ["Prompt suggestions"]
      : []),
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
    ...(isSandboxSettingsDirty ? ["Sandbox config"] : []),
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
        const result = await ensureNativeApi().server.updateProvider({
          provider,
        });
        const refreshedProvider = result.providers.find((status) => status.provider === provider);
        const failureMessage = providerUpdateFailureMessage(refreshedProvider);
        if (failureMessage) {
          toastManager.add({
            type: "error",
            title: `Could not update ${PROVIDER_DISPLAY_NAMES[provider]}`,
            description: failureMessage,
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
      const shown = await window.desktopBridge.notifications.show({
        title,
        body,
        silent: false,
      });
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

    const notification = new Notification(title, {
      body,
      tag: "synara:test-notification",
    });
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
              `${linkedActiveThreadCount} active and ${linkedArchivedThreadIds.length} archived conversation${linkedConversationCount === 1 ? " is" : "s are"} linked to this worktree.`,
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
        for (const archivedThreadId of linkedArchivedThreadIds) {
          await api.orchestration.dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: archivedThreadId,
          });
        }

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
              ? `${displayName} was removed and ${linkedArchivedThreadIds.length} archived conversation${linkedArchivedThreadIds.length === 1 ? "" : "s"} were deleted.`
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
    [queryClient, removeWorktreeMutation],
  );

  const unarchiveThread = useCallback(async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.unarchive",
        commandId: newCommandId(),
        threadId,
      });
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

  const deleteArchivedThread = useCallback(async (threadId: ThreadId, threadTitle: string) => {
    const api = readNativeApi();
    if (!api) return;

    const confirmed = await api.dialogs.confirm(
      `Permanently delete "${threadTitle}"?\n\nThis will remove the thread and its conversation history forever.`,
    );
    if (!confirmed) return;

    try {
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
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
  }, []);

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

  const renderGeneralPanel = () => (
    <GeneralSettings settings={settings} defaults={defaults} updateSettings={updateSettings} />
  );

  const renderAppearancePanel = () => (
    <AppearanceSettings
      theme={theme}
      resolvedTheme={resolvedTheme}
      setTheme={setTheme}
      settings={settings}
      defaults={defaults}
      updateSettings={updateSettings}
      shouldShowFontSmoothing={shouldShowFontSmoothing}
    />
  );

  const renderNotificationsPanel = () => (
    <NotificationsSettings
      settings={settings}
      defaults={defaults}
      updateSettings={updateSettings}
      browserNotificationPermission={browserNotificationPermission}
      onSetSystemNotifications={(nextEnabled) => void setSystemNotificationsEnabled(nextEnabled)}
      onSendTestNotification={() => void sendTestNotification()}
    />
  );

  const renderBehaviorPanel = () => (
    <BehaviorSettings settings={settings} defaults={defaults} updateSettings={updateSettings} />
  );

  const renderWorktreesPanel = () => (
    <WorktreesSettings
      worktreesByWorkspaceRoot={worktreesByWorkspaceRoot}
      isLoading={serverWorktreesQuery.isLoading}
      isError={serverWorktreesQuery.isError}
      error={serverWorktreesQuery.error}
      isDeleting={removeWorktreeMutation.isPending}
      onDeleteWorktree={(input) => void deleteManagedWorktree(input)}
    />
  );

  const renderArchivedPanel = () => (
    <ArchivedThreadsSettings
      projects={projects}
      archivedThreads={archivedThreads}
      onRestore={(threadId) => void unarchiveThread(threadId)}
      onDelete={(threadId, threadTitle) => void deleteArchivedThread(threadId, threadTitle)}
      onContextMenu={(threadId, threadTitle, position) =>
        void handleArchivedThreadContextMenu(threadId, threadTitle, position)
      }
    />
  );

  const renderModelsPanel = () => (
    <ModelsSettings
      settings={settings}
      defaults={defaults}
      updateSettings={updateSettings}
      selectedCustomModelProvider={selectedCustomModelProvider}
      setSelectedCustomModelProvider={setSelectedCustomModelProvider}
      customModelInputByProvider={customModelInputByProvider}
      setCustomModelInputByProvider={setCustomModelInputByProvider}
      customModelErrorByProvider={customModelErrorByProvider}
      setCustomModelErrorByProvider={setCustomModelErrorByProvider}
      showAllCustomModels={showAllCustomModels}
      setShowAllCustomModels={setShowAllCustomModels}
      onAddCustomModel={addCustomModel}
      onRemoveCustomModel={removeCustomModel}
    />
  );

  const renderProvidersPanel = () => (
    <ProvidersSettings
      settings={settings}
      defaults={defaults}
      updateSettings={updateSettings}
      providerUpdatesRef={providerUpdatesRef}
      providerInstallsRef={providerInstallsRef}
      outdatedProviderCount={outdatedProviderCount}
      outdatedProviderStatuses={outdatedProviderStatuses}
      providerStatusByProvider={providerStatusByProvider}
      updatingProviders={updatingProviders}
      onRunProviderUpdate={(provider) => void runProviderUpdate(provider)}
      hiddenProviderSet={hiddenProviderSet}
      hiddenProviderCount={hiddenProviderCount}
      isProviderOrderDirty={isProviderOrderDirty}
      onProviderOrderDragEnd={handleProviderOrderDragEnd}
      isInstallSettingsDirty={isInstallSettingsDirty}
      openInstallProviders={openInstallProviders}
      setOpenInstallProviders={setOpenInstallProviders}
    />
  );

  const renderSandboxesPanel = () => (
    <SandboxesSettings settings={settings} defaults={defaults} updateSettings={updateSettings} />
  );

  const renderAdvancedPanel = () => (
    <AdvancedSettings
      keybindingsConfigPath={keybindingsConfigPath}
      keybindingsError={openKeybindingsError}
      isOpeningKeybindings={isOpeningKeybindings}
      onOpenKeybindings={openKeybindingsFile}
      shouldOfferRecoveryTools={shouldOfferRecoveryTools}
      isRepairingLocalState={isRepairingLocalState}
      onRepairLocalState={() => void repairLocalState()}
      appVersion={APP_VERSION}
      onReleaseHistoryOpen={() => setReleaseHistoryOpen(true)}
    />
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
      case "worktrees":
        return renderWorktreesPanel();
      case "archived":
        return renderArchivedPanel();
      case "models":
        return renderModelsPanel();
      case "providers":
        return renderProvidersPanel();
      case "sandboxes":
        return renderSandboxesPanel();
      case "advanced":
        return renderAdvancedPanel();
      default:
        return null;
    }
  };

  return (
    <SidebarInset
      className={CHAT_ROUTE_INSET_SHELL_CLASS_NAME}
      surfaceClassName={cn(SETTINGS_PAGE_BACKGROUND_CLASS_NAME, CHAT_CONTENT_CARD_CLASS_NAME)}
    >
      {/* Companion sidebar trigger so settings is reachable-and-exitable even when the
          sidebar is collapsed (web/mobile have no global Back arrow). Pinned to the
          card's top-left — at the same header height + traffic-light gutter as the
          chat/workspace headers — so the collapsed-state toggle sits by the traffic
          lights instead of floating in the centered settings body. It renders nothing
          while the sidebar is open (SidebarHeaderNavigationControls returns null), so it
          adds no chrome in the common (open) state and never shifts the centered content
          (hence absolute, not a layout-occupying header row). */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center px-3 sm:px-5",
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
          <div className="mx-auto w-full max-w-2xl px-6 py-8">
            <div className="mb-8 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="text-[1.75rem] font-semibold tracking-tight text-foreground">
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
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
