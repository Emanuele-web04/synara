import {
  ProjectId,
  type ExternalMcpCapability,
  type ExternalMcpCreateIntegrationResult,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn, getNavigatorPlatform } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import {
  buildExternalMcpClientConfiguration,
  buildExternalMcpExamplePrompt,
  buildExternalMcpSetupPrompt,
  describeExternalMcpPermissions,
  describeExternalMcpProjects,
  externalMcpSetupAction,
} from "./externalMcpSetup";
import { SettingsListRow, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { t, useTranslation } from "~/i18n";

const INTEGRATIONS_QUERY_KEY = ["server", "externalMcpIntegrations"] as const;
const PROJECTS_QUERY_KEY = ["orchestration", "externalMcpProjects"] as const;
const DEFAULT_NAME = "Coding agent";
const CORE_CAPABILITIES: ReadonlyArray<ExternalMcpCapability> = [
  "projects:read",
  "tasks:create",
  "tasks:wait",
  "tasks:read",
];

function dateMillis(value: string): number {
  return Date.parse(value);
}

function formatDate(value: string | null, translate: typeof t, formatLocale: string): string {
  if (!value) return translate("settings:detail_never");
  const milliseconds = dateMillis(value);
  return Number.isNaN(milliseconds)
    ? String(value)
    : new Date(milliseconds).toLocaleString(formatLocale);
}

function copyWithToast(value: string, title: string): void {
  void copyTextToClipboard(value).then(
    () => toastManager.add({ type: "success", title }),
    (error: unknown) =>
      toastManager.add({
        type: "error",
        title: t("settings:couldNotCopy"),
        description: error instanceof Error ? error.message : t("git:clipboardAccessFailed"),
      }),
  );
}

export function ExternalMcpSettingsPanel(props: { active: boolean }) {
  const { t, formatLocale } = useTranslation();

  const queryClient = useQueryClient();
  const [name, setName] = useState<string>(DEFAULT_NAME);
  const [allProjects, setAllProjects] = useState(true);
  const [selectedProjects, setSelectedProjects] = useState<ReadonlySet<string>>(new Set());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [allowProjectRead, setAllowProjectRead] = useState(false);
  const [allowLocal, setAllowLocal] = useState(false);
  const [allowFullAccess, setAllowFullAccess] = useState(false);
  const [allowComputerControl, setAllowComputerControl] = useState(false);
  const [setup, setSetup] = useState<ExternalMcpCreateIntegrationResult | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!props.active) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [props.active]);

  const integrationsQuery = useQuery({
    queryKey: INTEGRATIONS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listExternalMcpIntegrations(),
    enabled: props.active,
    staleTime: 5_000,
    refetchInterval: setup ? 2_000 : false,
  });
  const projectsQuery = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: () => ensureNativeApi().orchestration.getShellSnapshot(),
    enabled: props.active,
    staleTime: 5_000,
  });
  const capabilities = useMemo(() => {
    const next = [...CORE_CAPABILITIES];
    if (allowProjectRead) next.push("tasks:read-project");
    if (allowLocal) next.push("runtime:local");
    if (allowFullAccess) next.push("runtime:full-access");
    if (allowComputerControl) next.push("computer:control");
    return next;
  }, [allowComputerControl, allowFullAccess, allowLocal, allowProjectRead]);

  const createMutation = useMutation({
    mutationFn: () =>
      ensureNativeApi().server.createExternalMcpIntegration({
        name: name.trim(),
        projectScope: allProjects ? "all" : "selected",
        ...(allProjects
          ? {}
          : {
              projectIds: [...selectedProjects].map((projectId) => ProjectId.makeUnsafe(projectId)),
            }),
        capabilities,
        expiresInDays: 30,
      }),
    onSuccess: (result) => {
      setManualOpen(false);
      setSetup(result);
      void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: t("settings:connectionReady"),
        description: t("settings:giveYourAgentTheSetupPromptBeforeTheOne"),
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: t("settings:couldNotCreateConnection"),
        description: error instanceof Error ? error.message : t("settings:externalMCPSetupFailed"),
      }),
  });

  const revokeMutation = useMutation({
    mutationFn: (integrationId: string) =>
      ensureNativeApi().server.revokeExternalMcpIntegration({ integrationId }),
    onSuccess: (_result, integrationId) => {
      setManualOpen(false);
      setSetup((current) =>
        current?.integration.integrationId === integrationId ? null : current,
      );
      void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: t("settings:connectionRevoked"),
        description: t("settings:itsCredentialStopsWorkingImmediately"),
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: t("settings:couldNotRevokeConnection"),
        description: error instanceof Error ? error.message : t("settings:revocationFailed"),
      }),
  });

  const refreshPairingMutation = useMutation({
    mutationFn: (integrationId: string) =>
      ensureNativeApi().server.refreshExternalMcpPairing({ integrationId }),
    onSuccess: (result) => {
      setSetup(result);
      void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: t("settings:newPairingCodeReady"),
        description: t("settings:copyTheRefreshedSetupPromptTheNewOneTime"),
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: t("settings:couldNotResumePairing"),
        description: error instanceof Error ? error.message : t("settings:pairingRefreshFailed"),
      }),
  });

  const continuePairedSetup = (integration: NonNullable<typeof integrationsQuery.data>[number]) => {
    setManualOpen(false);
    setSetup({
      integration,
      pairingCode: "already-paired",
      pairingExpiresAt: integration.createdAt,
      setupCommand: "Pairing already completed",
      stdio: integration.stdio,
    });
  };

  const closeSetup = () => {
    setManualOpen(false);
    setSetup(null);
  };

  const setupIntegration = setup
    ? (integrationsQuery.data?.find(
        (integration) => integration.integrationId === setup.integration.integrationId,
      ) ?? setup.integration)
    : null;

  if (!props.active) return null;

  const projects = projectsQuery.data?.projects ?? [];
  const canCreate =
    name.trim().length > 0 &&
    (allProjects || selectedProjects.size > 0) &&
    !createMutation.isPending;
  const paired = setupIntegration?.pairedAt != null;
  const connected = paired && setupIntegration?.lastUsedAt != null;
  const revoked = setupIntegration?.revokedAt != null;
  const integrationExpired = setupIntegration
    ? dateMillis(setupIntegration.expiresAt) <= nowMs
    : false;
  const pairingExpired = setup ? dateMillis(setup.pairingExpiresAt) <= nowMs : false;
  const setupUnavailable = revoked || integrationExpired || (!paired && pairingExpired);
  const setupAction = externalMcpSetupAction({
    revoked,
    integrationExpired,
    paired,
    pairingExpired,
  });
  const setupStatus = revoked
    ? t("settings:externalStatus_revoked")
    : integrationExpired
      ? t("settings:externalStatus_expired")
      : connected
        ? t("settings:externalStatus_connected")
        : paired
          ? t("settings:externalStatus_pairedWaiting")
          : pairingExpired
            ? t("settings:externalStatus_pairingExpired")
            : t("settings:externalStatus_waitingPairing");
  const platform = getNavigatorPlatform();
  const setupPrompt = setup
    ? buildExternalMcpSetupPrompt({
        setupCommand: paired ? null : setup.setupCommand,
        stdio: setup.stdio,
        platform,
      })
    : null;
  const manualConfiguration = setup
    ? buildExternalMcpClientConfiguration("other", setup.stdio, platform)
    : null;
  const examplePrompt = setup
    ? buildExternalMcpExamplePrompt(
        setup.integration.projectScope === "all"
          ? null
          : (setup.integration.allowedProjects[0]?.title ?? null),
      )
    : null;

  return (
    <div className="space-y-6">
      {!setup ? (
        <SettingsSection title="settings:connectACodingAgent">
          <SettingsRow
            id="setting-name"
            title="common:scripts_name"
            description="settings:howThisConnectionAppearsInSynaraWorksWithCodex"
            control={
              <Input
                className="w-full sm:w-64"
                value={name}
                maxLength={120}
                placeholder={DEFAULT_NAME}
                onChange={(event) => setName(event.target.value)}
              />
            }
          />
          <SettingsRow
            id="setting-access-all-of-synara"
            title="settings:accessAllOfSynara"
            description="settings:theAgentCanDiscoverAndWorkInEveryProject"
            control={<Switch checked={allProjects} onCheckedChange={setAllProjects} />}
          >
            <DisclosureRegion open={!allProjects} contentClassName="mt-3">
              <div className="grid gap-2 sm:grid-cols-2">
                {projects.map((project) => {
                  const checked = selectedProjects.has(project.id);
                  return (
                    <label
                      key={project.id}
                      className={cn(
                        "flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-ui leading-snug transition-colors",
                        checked ? "border-foreground/30 bg-muted/70" : "border-border/70",
                      )}
                    >
                      <span className="min-w-0 truncate">{project.title}</span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedProjects((current) => {
                            const next = new Set(current);
                            if (checked) next.delete(project.id);
                            else next.add(project.id);
                            return next;
                          })
                        }
                      />
                    </label>
                  );
                })}
                {projects.length === 0 ? (
                  <span className="text-ui leading-snug text-muted-foreground">
                    {t("settings:noProjectsAreAvailable")}
                  </span>
                ) : null}
              </div>
            </DisclosureRegion>
          </SettingsRow>
          <SettingsRow
            id="setting-advanced-permissions"
            title="settings:advancedPermissions"
            description="settings:optionalAccessForExistingTasksSharedCheckoutsOrExecution"
            control={
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((current) => !current)}
              >
                {t("chat:review")}
                <DisclosureChevron open={advancedOpen} className="ml-1 size-3.5" />
              </Button>
            }
          >
            <DisclosureRegion
              open={advancedOpen}
              contentClassName="mt-3 space-y-4 border-t border-border/70 pt-3"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-ui leading-snug font-medium">
                    {t("settings:readOtherProjectTasks")}
                  </div>
                  <div className="mt-0.5 text-ui-sm leading-relaxed text-muted-foreground">
                    {t("settings:withoutThisPermissionTheAgentCanReadOnlyTasks")}
                  </div>
                </div>
                <Switch checked={allowProjectRead} onCheckedChange={setAllowProjectRead} />
              </div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-ui leading-snug font-medium">
                    {t("settings:useTheSharedLocalCheckout")}
                  </div>
                  <div className="mt-0.5 text-ui-sm leading-relaxed text-muted-foreground">
                    {t("settings:highImpactTasksMayModifyTheCheckoutYouAre")}
                  </div>
                </div>
                <Switch checked={allowLocal} onCheckedChange={setAllowLocal} />
              </div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-ui leading-snug font-medium">
                    {t("settings:runWithoutApprovalPrompts")}
                  </div>
                  <div className="mt-0.5 text-ui-sm leading-relaxed text-muted-foreground">
                    {t("settings:highImpactTheExternalAgentMayStartFullAccess")}
                  </div>
                </div>
                <Switch checked={allowFullAccess} onCheckedChange={setAllowFullAccess} />
              </div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-medium">{t("settings:computerControl")}</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    {t("settings:highImpactTasksMayDriveThisMacSScreen")}
                  </div>
                </div>
                <Switch checked={allowComputerControl} onCheckedChange={setAllowComputerControl} />
              </div>
            </DisclosureRegion>
          </SettingsRow>
          <SettingsRow
            id="setting-create-connection"
            title="settings:createConnection"
            description="settings:theConnectionLasts30DaysAndCanBeRevoked"
            control={
              <Button size="sm" disabled={!canCreate} onClick={() => createMutation.mutate()}>
                {createMutation.isPending
                  ? t("common:kanban_creating")
                  : t("settings:createConnection")}
              </Button>
            }
          />
        </SettingsSection>
      ) : null}

      {setup && setupIntegration && setupPrompt && manualConfiguration && examplePrompt ? (
        <SettingsSection
          translateTitle={false}
          title={t("settings:connectorConnectTitle", { name: setupIntegration.name })}
        >
          <SettingsRow
            title={
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 rounded-full",
                    setupUnavailable
                      ? "bg-destructive"
                      : connected
                        ? "bg-green-500"
                        : "bg-amber-500",
                  )}
                />
                {setupStatus}
              </span>
            }
            description={
              revoked
                ? t("settings:externalConnectionRevoked")
                : integrationExpired
                  ? t("settings:externalConnectionExpired")
                  : connected
                    ? t("settings:externalConnectionReady")
                    : paired
                      ? t("settings:externalCredentialStored")
                      : pairingExpired
                        ? t("settings:externalPairingExpired")
                        : t("settings:externalPairingInstructions")
            }
            status={
              connected
                ? t("settings:externalLastConnected", {
                    date: formatDate(setupIntegration.lastUsedAt, t, formatLocale),
                  })
                : t("settings:externalConnectionExpires", {
                    date: formatDate(setupIntegration.expiresAt, t, formatLocale),
                  })
            }
            control={
              setupAction === "revoke" ? (
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={revokeMutation.isPending}
                  onClick={() => revokeMutation.mutate(setupIntegration.integrationId)}
                >
                  {t("settings:revokeAndStartOver")}
                </Button>
              ) : setupAction === "resume-pairing" ? (
                <div className="flex items-center gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={refreshPairingMutation.isPending}
                    onClick={() => refreshPairingMutation.mutate(setupIntegration.integrationId)}
                  >
                    {refreshPairingMutation.isPending
                      ? t("settings:resuming")
                      : t("settings:resumePairing")}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={closeSetup}>
                    {t("common:app_back")}
                  </Button>
                </div>
              ) : setupAction === "done" ? (
                <Button size="xs" variant="ghost" onClick={closeSetup}>
                  {t("git:detail_done")}
                </Button>
              ) : null
            }
          />
          <SettingsRow
            id="setting-1-give-your-agent-this-prompt"
            title="settings:1GiveYourAgentThisPrompt"
            description="settings:copyThePromptAndPasteItIntoTheAgent"
            status={
              paired
                ? t("settings:externalPairedPromptStatus")
                : t("settings:externalPairingExpires", {
                    date: formatDate(setup.pairingExpiresAt, t, formatLocale),
                  })
            }
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={setupUnavailable}
                onClick={() => copyWithToast(setupPrompt, t("settings:externalSetupPromptCopied"))}
              >
                {t("settings:copySetupPrompt")}
              </Button>
            }
          >
            <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/30 p-3 text-ui-sm leading-relaxed">
              {setupPrompt}
            </pre>
          </SettingsRow>
          <SettingsRow
            id="setting-set-up-by-hand-instead"
            title="settings:setUpByHandInstead"
            description="settings:forAppsWithoutATerminalOrChatLikeClaude"
            control={
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={manualOpen}
                onClick={() => setManualOpen((current) => !current)}
              >
                {t("chat:show")}
                <DisclosureChevron open={manualOpen} className="ml-1 size-3.5" />
              </Button>
            }
          >
            <DisclosureRegion
              open={manualOpen}
              contentClassName="mt-3 space-y-3 border-t border-border/70 pt-3"
            >
              {!paired ? (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-ui leading-snug font-medium">
                      {t("settings:pairingCommandRunInTerminal")}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={setupUnavailable}
                      onClick={() =>
                        copyWithToast(
                          setup.setupCommand,
                          t("settings:externalPairingCommandCopied"),
                        )
                      }
                    >
                      {t("workspace:share_copy")}
                    </Button>
                  </div>
                  <pre className="overflow-x-auto rounded-lg border border-border/70 bg-muted/30 p-3 text-ui-sm leading-relaxed">
                    {setup.setupCommand}
                  </pre>
                </div>
              ) : null}
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-ui leading-snug font-medium">
                    {t("settings:mCPConfigurationJSON")}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={revoked || integrationExpired}
                    onClick={() =>
                      copyWithToast(
                        manualConfiguration.value,
                        t("settings:externalConfigurationCopied"),
                      )
                    }
                  >
                    {t("workspace:share_copy")}
                  </Button>
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/30 p-3 text-ui-sm leading-relaxed">
                  {manualConfiguration.value}
                </pre>
              </div>
            </DisclosureRegion>
          </SettingsRow>
          <SettingsRow
            id="setting-2-try-it"
            title="settings:2TryIt"
            description="settings:openANewChatInTheAgentYouJust"
            status={
              connected
                ? t("settings:externalConnectionVerified")
                : t("settings:externalFirstRequestStatus")
            }
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={!paired || revoked || integrationExpired}
                onClick={() =>
                  copyWithToast(examplePrompt, t("settings:externalExamplePromptCopied"))
                }
              >
                {t("settings:copyExamplePrompt")}
              </Button>
            }
          >
            {paired ? (
              <div className="mt-3 rounded-lg border border-border/70 bg-muted/30 p-3 text-ui leading-relaxed text-muted-foreground">
                {examplePrompt}
              </div>
            ) : null}
          </SettingsRow>
        </SettingsSection>
      ) : null}

      <SettingsSection title="settings:connectedAgents">
        {integrationsQuery.isLoading ? (
          <SettingsListRow title={t("settings:loadingConnections")} />
        ) : integrationsQuery.data?.length ? (
          integrationsQuery.data.map((integration) => {
            const active =
              integration.revokedAt === null && dateMillis(integration.expiresAt) > nowMs;
            const status = active
              ? integration.lastUsedAt
                ? t("settings:externalStatus_connected")
                : integration.pairedAt
                  ? t("settings:externalStatus_pairedUnused")
                  : t("settings:externalStatus_waitingPairing")
              : integration.revokedAt
                ? t("settings:externalStatus_revoked")
                : t("settings:externalStatus_expired");
            return (
              <SettingsListRow
                key={integration.integrationId}
                align="start"
                title={integration.name}
                description={
                  <div className="space-y-1">
                    <div>{status}</div>
                    <div>
                      {t("settings:projects")}{" "}
                      {describeExternalMcpProjects(integration, t, formatLocale)}
                    </div>
                    <div>
                      {t("settings:permissions")}{" "}
                      {describeExternalMcpPermissions(integration.capabilities, t)}
                    </div>
                    <div>
                      {t("settings:created")} {formatDate(integration.createdAt, t, formatLocale)}{" "}
                      {t("settings:lastUsed")} {formatDate(integration.lastUsedAt, t, formatLocale)}{" "}
                      {t("settings:expires")} {formatDate(integration.expiresAt, t, formatLocale)}
                    </div>
                  </div>
                }
                actions={
                  active ? (
                    <div className="flex items-center gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={refreshPairingMutation.isPending}
                        onClick={() => {
                          if (integration.pairedAt) continuePairedSetup(integration);
                          else refreshPairingMutation.mutate(integration.integrationId);
                        }}
                      >
                        {integration.pairedAt
                          ? t("settings:continueSetup")
                          : t("settings:resumePairing")}
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        disabled={revokeMutation.isPending}
                        onClick={() => revokeMutation.mutate(integration.integrationId)}
                      >
                        {t("settings:revoke")}
                      </Button>
                    </div>
                  ) : null
                }
              />
            );
          })
        ) : (
          <SettingsListRow
            title={t("settings:noConnectedAgents")}
            description={t("settings:connectCodexClaudeOrAnotherLocalMCPAgentTo")}
          />
        )}
      </SettingsSection>
    </div>
  );
}
