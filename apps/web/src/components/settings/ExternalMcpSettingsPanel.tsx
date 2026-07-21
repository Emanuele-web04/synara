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
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import {
  buildExternalMcpClientConfiguration,
  buildExternalMcpExamplePrompt,
  describeExternalMcpPermissions,
  EXTERNAL_MCP_CLIENTS,
  type ExternalMcpClientKind,
} from "./externalMcpSetup";
import { SettingsListRow, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const INTEGRATIONS_QUERY_KEY = ["server", "externalMcpIntegrations"] as const;
const PROJECTS_QUERY_KEY = ["orchestration", "externalMcpProjects"] as const;
const CORE_CAPABILITIES: ReadonlyArray<ExternalMcpCapability> = [
  "projects:read",
  "tasks:create",
  "tasks:wait",
  "tasks:read",
];

function dateMillis(value: string): number {
  return Date.parse(value);
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const milliseconds = dateMillis(value);
  return Number.isNaN(milliseconds) ? String(value) : new Date(milliseconds).toLocaleString();
}

function copyWithToast(value: string, title: string): void {
  void copyTextToClipboard(value).then(
    () => toastManager.add({ type: "success", title }),
    (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not copy",
        description: error instanceof Error ? error.message : "Clipboard access failed.",
      }),
  );
}

export function ExternalMcpSettingsPanel(props: { active: boolean }) {
  const queryClient = useQueryClient();
  const [client, setClient] = useState<ExternalMcpClientKind>("codex");
  const [name, setName] = useState<string>(EXTERNAL_MCP_CLIENTS.codex.suggestedName);
  const [selectedProjects, setSelectedProjects] = useState<ReadonlySet<string>>(new Set());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [allowProjectRead, setAllowProjectRead] = useState(false);
  const [allowLocal, setAllowLocal] = useState(false);
  const [allowFullAccess, setAllowFullAccess] = useState(false);
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
    return next;
  }, [allowFullAccess, allowLocal, allowProjectRead]);

  const createMutation = useMutation({
    mutationFn: () =>
      ensureNativeApi().server.createExternalMcpIntegration({
        name: name.trim(),
        projectIds: [...selectedProjects].map((projectId) => ProjectId.makeUnsafe(projectId)),
        capabilities,
        expiresInDays: 30,
        clientKind: client,
      }),
    onSuccess: (result) => {
      setSetup(result);
      void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: "Integration ready",
        description: "Complete the guided pairing before the one-time code expires.",
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not create integration",
        description: error instanceof Error ? error.message : "External MCP setup failed.",
      }),
  });

  const revokeMutation = useMutation({
    mutationFn: (integrationId: string) =>
      ensureNativeApi().server.revokeExternalMcpIntegration({ integrationId }),
    onSuccess: (_result, integrationId) => {
      setSetup((current) =>
        current?.integration.integrationId === integrationId ? null : current,
      );
      void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: "Integration revoked",
        description: "Its credential stops working immediately.",
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not revoke integration",
        description: error instanceof Error ? error.message : "Revocation failed.",
      }),
  });

  const refreshPairingMutation = useMutation({
    mutationFn: (integrationId: string) =>
      ensureNativeApi().server.refreshExternalMcpPairing({ integrationId }),
    onSuccess: (result) => {
      setClient(result.integration.clientKind);
      setSetup(result);
      void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: "New pairing code ready",
        description: "Continue from step 1. The new one-time code lasts 10 minutes.",
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not resume pairing",
        description: error instanceof Error ? error.message : "Pairing refresh failed.",
      }),
  });

  const continuePairedSetup = (integration: NonNullable<typeof integrationsQuery.data>[number]) => {
    setClient(integration.clientKind);
    setSetup({
      integration,
      pairingCode: "already-paired",
      pairingExpiresAt: integration.createdAt,
      setupCommand: "Pairing already completed",
      stdio: integration.stdio,
    });
  };

  const setupIntegration = setup
    ? (integrationsQuery.data?.find(
        (integration) => integration.integrationId === setup.integration.integrationId,
      ) ?? setup.integration)
    : null;
  const clientConfiguration = setup
    ? buildExternalMcpClientConfiguration(
        client,
        setup.stdio,
        typeof navigator === "undefined" ? "" : navigator.platform,
      )
    : null;
  const examplePrompt = setup
    ? buildExternalMcpExamplePrompt(
        setup.integration.allowedProjects[0]?.title ?? "the selected project",
      )
    : null;

  if (!props.active) return null;

  const projects = projectsQuery.data?.projects ?? [];
  const canCreate =
    name.trim().length > 0 && selectedProjects.size > 0 && !createMutation.isPending;
  const paired = setupIntegration?.pairedAt != null;
  const connected = paired && setupIntegration?.lastUsedAt != null;
  const revoked = setupIntegration?.revokedAt != null;
  const integrationExpired = setupIntegration
    ? dateMillis(setupIntegration.expiresAt) <= nowMs
    : false;
  const pairingExpired = setup ? dateMillis(setup.pairingExpiresAt) <= nowMs : false;
  const setupUnavailable = revoked || integrationExpired || (!paired && pairingExpired);
  const setupStatus = revoked
    ? "Revoked"
    : integrationExpired
      ? "Expired"
      : connected
        ? "Connected"
        : paired
          ? "Paired — waiting for first use"
          : pairingExpired
            ? "Pairing code expired"
            : "Waiting for pairing";

  return (
    <div className="space-y-6">
      {!setup ? (
        <SettingsSection title="Connect an app">
          <SettingsRow
            title="Choose your app"
            description="Synara will generate the right setup instructions for the app you use."
          >
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(
                Object.entries(EXTERNAL_MCP_CLIENTS) as ReadonlyArray<
                  [ExternalMcpClientKind, (typeof EXTERNAL_MCP_CLIENTS)[ExternalMcpClientKind]]
                >
              ).map(([kind, option]) => {
                const selected = client === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={selected}
                    className={cn(
                      "rounded-lg border px-3 py-3 text-left transition-colors",
                      selected
                        ? "border-foreground/30 bg-muted/70"
                        : "border-border/70 hover:bg-muted/40",
                    )}
                    onClick={() => {
                      setClient(kind);
                      setName(option.suggestedName);
                    }}
                  >
                    <span className="block text-xs font-medium">{option.label}</span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                      {option.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </SettingsRow>
          <SettingsRow
            title="Integration name"
            description="This is how the connection will appear in Synara."
            control={
              <Input
                className="w-full sm:w-64"
                value={name}
                maxLength={120}
                placeholder={EXTERNAL_MCP_CLIENTS[client].suggestedName}
                onChange={(event) => setName(event.target.value)}
              />
            }
          />
          <SettingsRow
            title="Allowed projects"
            description="The app can discover and create tasks only in the projects you select."
          >
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {projects.map((project) => {
                const checked = selectedProjects.has(project.id);
                return (
                  <label
                    key={project.id}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs transition-colors",
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
                <span className="text-xs text-muted-foreground">No projects are available.</span>
              ) : null}
            </div>
          </SettingsRow>
          <SettingsRow
            title="Advanced permissions"
            description="Optional access for existing tasks, shared checkouts, or execution without approvals. The safe defaults are recommended."
            control={
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((current) => !current)}
              >
                Review
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
                  <div className="text-xs font-medium">Read other project tasks</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    Without this permission, the app can read only tasks it creates.
                  </div>
                </div>
                <Switch checked={allowProjectRead} onCheckedChange={setAllowProjectRead} />
              </div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-medium">Use the shared local checkout</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    High impact. Tasks may modify the checkout you are actively using instead of an
                    isolated worktree.
                  </div>
                </div>
                <Switch checked={allowLocal} onCheckedChange={setAllowLocal} />
              </div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-medium">Run without approval prompts</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    High impact. The external app may start full-access execution without asking you
                    to approve tool actions.
                  </div>
                </div>
                <Switch checked={allowFullAccess} onCheckedChange={setAllowFullAccess} />
              </div>
            </DisclosureRegion>
          </SettingsRow>
          <SettingsRow
            title="Create connection"
            description="The connection lasts 30 days and can be revoked at any time. The next screen guides you through pairing."
            control={
              <Button size="sm" disabled={!canCreate} onClick={() => createMutation.mutate()}>
                {createMutation.isPending ? "Creating..." : "Create integration"}
              </Button>
            }
          />
        </SettingsSection>
      ) : null}

      {setup && setupIntegration && clientConfiguration && examplePrompt ? (
        <SettingsSection title={`Connect ${EXTERNAL_MCP_CLIENTS[client].label}`}>
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
                ? "This connection has been revoked and can no longer access Synara."
                : integrationExpired
                  ? "This connection has expired and can no longer access Synara."
                  : connected
                    ? "Synara received a request from this app. Setup is complete."
                    : paired
                      ? "The private credential is stored locally. Add Synara to your app, then try the prompt below."
                      : pairingExpired
                        ? "The one-time pairing code was not used in time. Revoke this connection and create a new one."
                        : "Run the first command below. This page updates automatically when pairing succeeds."
            }
            status={
              connected
                ? `Last connected ${formatDate(setupIntegration.lastUsedAt)}.`
                : `Integration expires ${formatDate(setupIntegration.expiresAt)}.`
            }
            control={
              setupUnavailable ? (
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={revokeMutation.isPending}
                  onClick={() => revokeMutation.mutate(setupIntegration.integrationId)}
                >
                  Revoke and start over
                </Button>
              ) : paired ? (
                <Button size="xs" variant="ghost" onClick={() => setSetup(null)}>
                  Done
                </Button>
              ) : null
            }
          />
          <SettingsRow
            title="1. Pair this computer"
            description={
              paired
                ? "Paired. The one-time code has been consumed and cannot be used again."
                : "Copy this command, paste it into Terminal—not into an AI chat—and press Return. No credential is added to your app's configuration."
            }
            status={
              paired ? "Completed" : `Pairing code expires ${formatDate(setup.pairingExpiresAt)}.`
            }
            control={
              paired ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={setupUnavailable}
                  onClick={() => copyWithToast(setup.setupCommand, "Pairing command copied")}
                >
                  Copy pairing command
                </Button>
              )
            }
          >
            {!paired ? (
              <pre className="mt-3 overflow-x-auto rounded-lg border border-border/70 bg-muted/30 p-3 text-[11px] leading-relaxed">
                {setup.setupCommand}
              </pre>
            ) : null}
          </SettingsRow>
          <SettingsRow
            title={`2. Add Synara to ${EXTERNAL_MCP_CLIENTS[client].label}`}
            description={
              paired
                ? clientConfiguration.instruction
                : "This step unlocks automatically after the pairing command succeeds."
            }
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={!paired || revoked || integrationExpired}
                onClick={() =>
                  copyWithToast(
                    clientConfiguration.value,
                    `${clientConfiguration.copyLabel} copied`,
                  )
                }
              >
                {clientConfiguration.copyLabel}
              </Button>
            }
          >
            {paired ? (
              <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/30 p-3 text-[11px] leading-relaxed">
                {clientConfiguration.value}
              </pre>
            ) : null}
          </SettingsRow>
          <SettingsRow
            title="3. Try it"
            description="Open a new chat in the app you just connected and send this editable example. You never need to copy project IDs, model IDs, or request IDs yourself."
            status={
              connected
                ? "Connection verified by Synara."
                : "Synara will show Connected after the app makes its first request."
            }
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={!paired || revoked || integrationExpired}
                onClick={() => copyWithToast(examplePrompt, "Example prompt copied")}
              >
                Copy example prompt
              </Button>
            }
          >
            {paired ? (
              <div className="mt-3 rounded-lg border border-border/70 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                {examplePrompt}
              </div>
            ) : null}
          </SettingsRow>
        </SettingsSection>
      ) : null}

      <SettingsSection title="External MCP integrations">
        {integrationsQuery.isLoading ? (
          <SettingsListRow title="Loading integrations..." />
        ) : integrationsQuery.data?.length ? (
          integrationsQuery.data.map((integration) => {
            const active =
              integration.revokedAt === null && dateMillis(integration.expiresAt) > nowMs;
            const status = active
              ? integration.lastUsedAt
                ? "Connected"
                : integration.pairedAt
                  ? "Paired — not used yet"
                  : "Waiting for pairing"
              : integration.revokedAt
                ? "Revoked"
                : "Expired";
            return (
              <SettingsListRow
                key={integration.integrationId}
                align="start"
                title={integration.name}
                description={
                  <div className="space-y-1">
                    <div>{status}</div>
                    <div>
                      Projects:{" "}
                      {integration.allowedProjects.map((project) => project.title).join(", ")}
                    </div>
                    <div>
                      Permissions: {describeExternalMcpPermissions(integration.capabilities)}
                    </div>
                    <div>
                      Created {formatDate(integration.createdAt)} · Last used{" "}
                      {formatDate(integration.lastUsedAt)} · Expires{" "}
                      {formatDate(integration.expiresAt)}
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
                        {integration.pairedAt ? "Continue setup" : "Resume pairing"}
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        disabled={revokeMutation.isPending}
                        onClick={() => revokeMutation.mutate(integration.integrationId)}
                      >
                        Revoke
                      </Button>
                    </div>
                  ) : null
                }
              />
            );
          })
        ) : (
          <SettingsListRow
            title="No integrations"
            description="Connect Codex, Claude, or another local MCP app to create and follow Synara tasks."
          />
        )}
      </SettingsSection>
    </div>
  );
}
