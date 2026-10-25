// FILE: McpConnectorConnectDialog.tsx
// Purpose: Consent dialog shown before Synara signs in to a connector: what the user
//   controls, the risk, and what data flows where, then a capsule to continue.
// Layer: Settings UI components
// Exports: McpConnectorConnectDialog, McpConnectorTarget

import { MCP_CONNECTOR_CLIENT_REQUIRED_ERROR_CODE, type McpConnector } from "@synara/contracts";
import { normalizeMcpConnectorUrl } from "@synara/shared/mcpConnectors";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { AppIconTile, ConnectorDots } from "~/components/AppIconTile";
import { ConnectorIcon } from "~/components/ConnectorIcon";
import { SynaraLogo } from "@synara/profile-ui/logo";
import { Button } from "~/components/ui/button";
import { CopyTextButton } from "~/components/ui/copyTextButton";
import {
  Dialog,
  dialogFieldLabelClassName,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { readableBrandColor } from "~/lib/brandIcons";
import { mcpConnectorsQueryOptions } from "~/lib/mcpConnectorsReactQuery";
import { ArrowUpRightIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";

import { mcpConnectorArtwork } from "./McpConnectorGlyph";
import { SettingsCard } from "./SettingsPanelPrimitives";

/** Stop waiting for the browser sign-in after the server forgets the attempt. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export interface McpConnectorTarget {
  readonly presetId: string | null;
  readonly name: string;
  readonly url: string;
  readonly docsUrl: string | null;
  /** The server registers no clients, so the user brings their own OAuth app. */
  readonly requiresOwnApp?: boolean;
  readonly reuseSavedClient?: boolean;
  readonly appSetupUrl?: string | null;
}

function isClientRequiredError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === MCP_CONNECTOR_CLIENT_REQUIRED_ERROR_CODE
  );
}

const NEUTRAL_GLOW = "color-mix(in srgb, var(--foreground) 38%, transparent)";

function ConsentSection(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3.5">
      <h3 className="text-ui-lg font-medium text-foreground">{props.title}</h3>
      <p className="mt-1 text-ui leading-relaxed text-muted-foreground">{props.children}</p>
    </div>
  );
}

function isTargetConnected(
  connectors: ReadonlyArray<McpConnector> | undefined,
  target: McpConnectorTarget,
  sinceMs: number,
): McpConnector | undefined {
  const normalized = normalizeMcpConnectorUrl(target.url);
  const url = normalized.ok ? normalized.url : target.url;
  return connectors?.find(
    (connector) =>
      connector.url === url &&
      connector.status === "connected" &&
      Date.parse(connector.updatedAt) >= sinceMs,
  );
}

export function McpConnectorConnectDialog(props: {
  target: McpConnectorTarget | null;
  onOpenChange: (open: boolean) => void;
  onConnected: (connector: McpConnector) => void;
}) {
  const { target, onConnected } = props;
  const [error, setError] = useState<string | null>(null);
  // Set once the browser sign-in starts; the list is polled until it lands.
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  // The user's own OAuth app, asked for up front (Slack) or after the server
  // turns out not to register clients itself.
  const [askForOwnApp, setAskForOwnApp] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const needsOwnApp = askForOwnApp || target?.requiresOwnApp === true;

  useEffect(() => {
    setError(null);
    setWaitingSince(null);
    setAskForOwnApp(false);
    setClientId("");
    setClientSecret("");
  }, [target?.url]);

  const setupQuery = useQuery({
    queryKey: ["server", "mcpConnectorSetup"],
    queryFn: () => ensureNativeApi().server.getMcpConnectorSetup(),
    enabled: needsOwnApp,
    staleTime: Infinity,
    retry: false,
  });

  const connectMutation = useMutation({
    mutationFn: (input: McpConnectorTarget) => {
      const ownApp = clientId.trim()
        ? {
            clientId: clientId.trim(),
            ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
          }
        : {};
      return ensureNativeApi().server.connectMcpConnector(
        input.presetId
          ? { presetId: input.presetId, ...ownApp }
          : { url: input.url, name: input.name, ...ownApp },
      );
    },
  });

  const listQuery = useQuery({
    ...mcpConnectorsQueryOptions(),
    enabled: waitingSince !== null,
    refetchInterval: waitingSince !== null ? 1_500 : false,
  });

  useEffect(() => {
    if (waitingSince === null || !target) return;
    const connected = isTargetConnected(listQuery.data, target, waitingSince);
    if (connected) {
      setWaitingSince(null);
      onConnected(connected);
      return;
    }
    const timer = window.setTimeout(
      () => {
        setWaitingSince(null);
        setError(`The sign-in to ${target.name} timed out. Try again.`);
      },
      Math.max(0, waitingSince + SIGN_IN_TIMEOUT_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [listQuery.data, onConnected, target, waitingSince]);

  const start = async () => {
    if (!target) return;
    setError(null);
    const startedAt = Date.now();
    try {
      const result = await connectMutation.mutateAsync(target);
      if (result.connector) {
        onConnected(result.connector);
        return;
      }
      if (result.authorizationUrl) {
        setWaitingSince(startedAt);
        await ensureNativeApi().shell.openExternal(result.authorizationUrl);
      }
    } catch (cause) {
      setWaitingSince(null);
      if (isClientRequiredError(cause) && !needsOwnApp) {
        // Ask for the app instead of showing a dead end.
        setAskForOwnApp(true);
        return;
      }
      setError(cause instanceof Error ? cause.message : `Synara could not connect ${target.name}.`);
    }
  };

  const brandColor = readableBrandColor(mcpConnectorArtwork(target?.presetId ?? null).color);
  const busy = connectMutation.isPending || waitingSince !== null;
  const missingOwnApp = needsOwnApp && !target?.reuseSavedClient && !clientId.trim();
  const name = target?.name ?? "";

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setWaitingSince(null);
        props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-[440px]">
        {target ? (
          <div className="flex min-h-0 flex-col items-center gap-5 overflow-y-auto px-6 pt-9 pb-6">
            <span className="flex items-center gap-3" aria-hidden="true">
              <AppIconTile
                size="xl"
                glow="right"
                glowColor={NEUTRAL_GLOW}
                className="bg-black text-white"
              >
                <SynaraLogo className="size-8 text-white" />
              </AppIconTile>
              <ConnectorDots
                size="xl"
                dotClassNames={["bg-foreground/20", "bg-foreground/20", "bg-foreground/20"]}
              />
              <AppIconTile
                size="xl"
                glow="left"
                glowColor={
                  brandColor ? `color-mix(in srgb, ${brandColor} 60%, transparent)` : NEUTRAL_GLOW
                }
                className="bg-background"
              >
                <ConnectorIcon name={target.name} url={target.url} className="size-8" />
              </AppIconTile>
            </span>

            <DialogTitle className="text-center text-2xl">Connect {name}</DialogTitle>

            <SettingsCard className="w-full">
              <ConsentSection title="You're in control">
                Agents get only the access {name} grants Synara, and you can disconnect it anytime
                in Settings.
              </ConsentSection>
              <ConsentSection title="Connectors may introduce elevated risk">
                {name} is run by its own provider, not Synara. Its tools can read and change data in
                your account, and content it returns could try to steer your agent. Review tool
                calls before you approve them.
              </ConsentSection>
              <ConsentSection title="Data shared with this connector">
                When an agent uses {name}, its request and the context it needs are sent to {name},
                and the answers go to the AI provider running the chat. {name}'s terms and privacy
                policy apply. Your sign-in stays on this computer and is never shared with AI
                providers.
                {target.docsUrl ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="rounded-sm text-foreground underline decoration-muted-foreground/40 underline-offset-[3px] hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => {
                        const url = target.docsUrl;
                        if (url) void ensureNativeApi().shell.openExternal(url);
                      }}
                    >
                      Learn more
                    </button>
                  </>
                ) : null}
              </ConsentSection>
            </SettingsCard>

            {needsOwnApp ? (
              <SettingsCard className="w-full">
                <div className="space-y-3 px-4 py-3.5">
                  <div>
                    <h3 className="text-ui-lg font-medium text-foreground">
                      Use your own {name} app
                    </h3>
                    <p className="mt-1 text-ui leading-relaxed text-muted-foreground">
                      {name} only signs in apps registered with it.{" "}
                      {target.appSetupUrl ? (
                        <button
                          type="button"
                          className="rounded-sm text-foreground underline decoration-muted-foreground/40 underline-offset-[3px] hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring"
                          onClick={() => {
                            const url = target.appSetupUrl;
                            if (url) void ensureNativeApi().shell.openExternal(url);
                          }}
                        >
                          Create an app
                        </button>
                      ) : (
                        "Create an app"
                      )}
                      , add this redirect URL to it, then paste its client ID and secret.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className={dialogFieldLabelClassName}>Redirect URL</span>
                      {setupQuery.data ? (
                        <CopyTextButton text={setupQuery.data.redirectUrl} label="URL" />
                      ) : null}
                    </div>
                    <Input
                      readOnly
                      value={setupQuery.data?.redirectUrl ?? ""}
                      aria-label="Redirect URL"
                    />
                  </div>
                  <label className="block space-y-1.5">
                    <span className={dialogFieldLabelClassName}>Client ID</span>
                    <Input
                      value={clientId}
                      maxLength={256}
                      autoComplete="off"
                      onChange={(event) => setClientId(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className={dialogFieldLabelClassName}>Client secret</span>
                    <Input
                      type="password"
                      value={clientSecret}
                      maxLength={512}
                      autoComplete="off"
                      onChange={(event) => setClientSecret(event.target.value)}
                    />
                  </label>
                </div>
              </SettingsCard>
            ) : null}

            {error ? (
              <p role="alert" className="w-full text-center text-ui leading-snug text-destructive">
                {error}
              </p>
            ) : null}

            <div className="flex w-full flex-col items-center gap-2">
              <Button
                variant="prominent"
                shape="capsule"
                size="xl"
                className="w-full hover:scale-100"
                disabled={busy || missingOwnApp}
                onClick={() => {
                  void start();
                }}
              >
                {busy ? (
                  <>
                    <Spinner />
                    {waitingSince !== null ? `Waiting for ${name}…` : "Connecting…"}
                  </>
                ) : (
                  <>
                    Continue to {name}
                    <ArrowUpRightIcon />
                  </>
                )}
              </Button>
              {waitingSince !== null ? (
                <p className="text-center text-ui-sm text-muted-foreground">
                  Finish signing in in your browser. This updates on its own.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
