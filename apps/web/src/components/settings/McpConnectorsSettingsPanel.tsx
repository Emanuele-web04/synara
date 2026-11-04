import { t, useTranslation } from "~/i18n";
// FILE: McpConnectorsSettingsPanel.tsx
// Purpose: Settings → Connectors: a searchable catalog laid out in shelves, the
//   connected services with their actions, and a dialog to add a custom MCP server URL.
// Layer: Settings UI components
// Exports: McpConnectorsSettingsPanel

import type { McpConnector } from "@synara/contracts";
import {
  defaultMcpConnectorName,
  MCP_CONNECTOR_CATEGORIES,
  MCP_CONNECTOR_PRESETS,
  type McpConnectorCategory,
  type McpConnectorPreset,
  type McpConnectorUrlReasonCode,
  normalizeMcpConnectorUrl,
} from "@synara/shared/mcpConnectors";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useId,
  useState,
} from "react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { IconButton } from "~/components/ui/icon-button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { SearchInput } from "~/components/ui/search-input";
import { toastManager } from "~/components/ui/toast";
import { AddPlusIcon, EllipsisIcon } from "~/lib/icons";
import { MCP_CONNECTORS_QUERY_KEY, mcpConnectorsQueryOptions } from "~/lib/mcpConnectorsReactQuery";
import { ensureNativeApi } from "~/nativeApi";

import { McpConnectorConnectDialog, type McpConnectorTarget } from "./McpConnectorConnectDialog";
import { McpConnectorGlyph } from "./McpConnectorGlyph";
import { SettingsEmptyState } from "./SettingsPanelPrimitives";

const CATEGORY_LABELS: Record<McpConnectorCategory, string> = {
  popular: "settings:connectorPopular",
  developer: "settings:advanced_developerTools",
  productivity: "settings:connectorProductivity",
};

const PRESET_DESCRIPTION_KEYS: Readonly<Record<string, string>> = {
  supabase: "settings:connectorSupabaseDescription",
  vercel: "settings:connectorVercelDescription",
  workos: "settings:connectorWorkosDescription",
  convex: "settings:connectorConvexDescription",
  cloudflare: "settings:connectorCloudflareDescription",
  slack: "settings:connectorSlackDescription",
  linear: "settings:connectorLinearDescription",
  notion: "settings:connectorNotionDescription",
  sentry: "settings:connectorSentryDescription",
  stripe: "settings:connectorStripeDescription",
  neon: "settings:connectorNeonDescription",
  atlassian: "settings:connectorAtlassianDescription",
  todoist: "settings:connectorTodoistDescription",
  posthog: "settings:connectorPosthogDescription",
  netlify: "settings:connectorNetlifyDescription",
  railway: "settings:connectorRailwayDescription",
  prisma: "settings:connectorPrismaDescription",
  huggingface: "settings:connectorHuggingfaceDescription",
};

function presetDescription(preset: McpConnectorPreset | undefined, translate: typeof t): string {
  if (!preset) return "";
  const key = PRESET_DESCRIPTION_KEYS[preset.id];
  return key ? translate(key) : preset.description;
}

const URL_REASON_KEYS: Record<McpConnectorUrlReasonCode, string> = {
  required: "settings:connectorUrlRequired",
  "too-long": "settings:connectorUrlTooLong",
  invalid: "settings:connectorUrlInvalid",
  "https-required": "settings:connectorUrlHttps",
  credentials: "settings:connectorUrlCredentials",
  "public-host": "settings:connectorUrlPublicHost",
};

function presetTarget(preset: McpConnectorPreset): McpConnectorTarget {
  return {
    presetId: preset.id,
    name: preset.name,
    url: preset.url,
    docsUrl: preset.docsUrl,
    ...(preset.requiresOwnApp ? { requiresOwnApp: true } : {}),
    appSetupUrl: preset.appSetupUrl ?? null,
  };
}

function connectorPreset(connector: McpConnector): McpConnectorPreset | undefined {
  return MCP_CONNECTOR_PRESETS.find((entry) => entry.id === connector.presetId);
}

// Reuse saved credentials, but keep the current redirect visible: the desktop
// callback port may have changed since the user's OAuth app was registered.
function connectorTarget(connector: McpConnector): McpConnectorTarget {
  const preset = connectorPreset(connector);
  return preset
    ? {
        ...presetTarget(preset),
        requiresOwnApp: connector.usesOwnOAuthApp === true,
        reuseSavedClient: true,
      }
    : {
        presetId: null,
        name: connector.name,
        url: connector.url,
        docsUrl: null,
        requiresOwnApp: connector.usesOwnOAuthApp === true,
        reuseSavedClient: true,
      };
}

// Host only: some servers put an API key in the URL path.
function connectorHost(connector: McpConnector): string {
  return new URL(connector.url).host;
}

function matchesSearch(query: string, ...fields: ReadonlyArray<string>): boolean {
  return query.length === 0 || fields.some((field) => field.toLowerCase().includes(query));
}

function ConnectorShelf(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h2 className="px-3 text-ui-lg font-medium text-foreground">{props.title}</h2>
      <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2">{props.children}</div>
    </section>
  );
}

const CONNECTOR_ROW_CLASS_NAME = "flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5";

function ConnectorRowText(props: { title: string; description: ReactNode }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-ui-lg font-medium leading-snug text-foreground">
        {props.title}
      </span>
      <span className="mt-0.5 block truncate text-ui text-muted-foreground">
        {props.description}
      </span>
    </span>
  );
}

function PresetRow(props: { preset: McpConnectorPreset; onSelect: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={`${CONNECTOR_ROW_CLASS_NAME} group text-left transition-colors hover:bg-[var(--sidebar-accent)] focus-visible:outline-2 focus-visible:outline-ring`}
    >
      <McpConnectorGlyph name={props.preset.name} url={props.preset.url} />
      <ConnectorRowText
        title={props.preset.name}
        description={presetDescription(props.preset, t)}
      />
      <AddPlusIcon
        className="size-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
        aria-hidden="true"
      />
    </button>
  );
}

function ConnectedRow(props: {
  connector: McpConnector;
  disconnecting: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();

  const { connector } = props;
  const needsAuth = connector.status === "needs-auth";
  return (
    <div className={CONNECTOR_ROW_CLASS_NAME}>
      <McpConnectorGlyph name={connector.name} url={connector.url} />
      <ConnectorRowText
        title={connector.name}
        description={
          needsAuth ? (
            <span className="text-destructive">{t("settings:connectorSignInExpired")}</span>
          ) : (
            presetDescription(connectorPreset(connector), t) || connectorHost(connector)
          )
        }
      />
      {needsAuth ? (
        <Button size="xs" variant="outline" onClick={props.onReconnect}>
          {t("settings:connectorReconnect")}
        </Button>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              variant="ghost"
              size="icon-sm"
              shape="capsule"
              label={t("settings:connectorActions", { name: connector.name })}
              disabled={props.disconnecting}
            >
              <EllipsisIcon className="size-4" />
            </IconButton>
          }
        />
        <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={6} className="w-44 min-w-44">
          {needsAuth ? null : (
            <MenuItem onClick={props.onReconnect}>{t("settings:connectorReconnect")}</MenuItem>
          )}
          <MenuItem variant="destructive" onClick={props.onDisconnect}>
            {t("settings:connectorDisconnect")}
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  );
}

function AddCustomConnectorDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (url: string) => void;
}) {
  const { t } = useTranslation();

  const formId = useId();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeMcpConnectorUrl(url);
    if (!normalized.ok) {
      setError(
        normalized.reasonCode ? t(URL_REASON_KEYS[normalized.reasonCode]) : normalized.reason,
      );
      return;
    }
    setUrl("");
    setError(null);
    props.onSubmit(normalized.url);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setError(null);
        props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings:addCustomConnector")}</DialogTitle>
          <DialogDescription>{t("settings:customConnectorDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="space-y-1.5" onSubmit={submit} noValidate>
            <Input
              value={url}
              maxLength={2048}
              placeholder="https://mcp.example.com/mcp"
              aria-label={t("settings:mcpServerUrl")}
              aria-invalid={error ? true : undefined}
              autoFocus
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
            />
            {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("common:form_cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={!url.trim()}>
            {t("git:continue")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function McpConnectorsSettingsPanel(props: { active: boolean }) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const [target, setTarget] = useState<McpConnectorTarget | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  const connectorsQuery = useQuery({
    ...mcpConnectorsQueryOptions(),
    enabled: props.active,
  });

  const disconnectMutation = useMutation({
    mutationFn: (connectorId: string) =>
      ensureNativeApi().server.disconnectMcpConnector({ connectorId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MCP_CONNECTORS_QUERY_KEY }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: t("settings:connectorDisconnectFailed"),
        description: error instanceof Error ? error.message : t("chat:tryAgain"),
      }),
  });

  const onConnected = useCallback(
    (connector: McpConnector) => {
      setTarget(null);
      void queryClient.invalidateQueries({ queryKey: MCP_CONNECTORS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: t("settings:connectorConnected", { name: connector.name }),
        description: t("settings:connectorToolsNewChats"),
      });
    },
    [queryClient, t],
  );

  const disconnect = async (connector: McpConnector) => {
    const confirmed = await ensureNativeApi().dialogs.confirm(
      t("settings:connectorDisconnectConfirm", { name: connector.name }),
    );
    if (confirmed) disconnectMutation.mutate(connector.connectorId);
  };

  if (!props.active) return null;

  const query = deferredSearch.trim().toLowerCase();
  const connectors = connectorsQuery.data ?? [];
  const connectedUrls = new Set(connectors.map((connector) => connector.url));
  const visibleConnectors = connectors.filter((connector) =>
    matchesSearch(
      query,
      connector.name,
      connectorHost(connector),
      presetDescription(connectorPreset(connector), t),
    ),
  );
  const shelves = MCP_CONNECTOR_CATEGORIES.map((category) => ({
    category,
    presets: MCP_CONNECTOR_PRESETS.filter(
      (preset) =>
        preset.category === category &&
        !connectedUrls.has(preset.url) &&
        matchesSearch(query, preset.name, presetDescription(preset, t)),
    ),
  })).filter((shelf) => shelf.presets.length > 0);

  const addCustom = (url: string) => {
    setAddOpen(false);
    const preset = MCP_CONNECTOR_PRESETS.find((entry) => entry.url === url);
    setTarget(
      preset
        ? presetTarget(preset)
        : { presetId: null, name: defaultMcpConnectorName(url), url, docsUrl: null },
    );
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2">
        <SearchInput
          type="search"
          nativeInput
          shape="capsule"
          placeholder={t("settings:searchConnectors")}
          aria-label={t("settings:searchConnectors")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && search.length > 0) {
              event.preventDefault();
              event.stopPropagation();
              setSearch("");
            }
          }}
        />
        <Button shape="capsule" className="shrink-0" onClick={() => setAddOpen(true)}>
          <AddPlusIcon className="size-4" />
          {t("settings:addCustom")}
        </Button>
      </div>

      {connectorsQuery.isError ? (
        <SettingsEmptyState layout="status" tone="destructive">
          {connectorsQuery.error instanceof Error
            ? connectorsQuery.error.message
            : t("settings:connectorsLoadFailed")}
        </SettingsEmptyState>
      ) : null}

      {visibleConnectors.length > 0 ? (
        <ConnectorShelf title={t("chat:connected")}>
          {visibleConnectors.map((connector) => (
            <ConnectedRow
              key={connector.connectorId}
              connector={connector}
              disconnecting={disconnectMutation.isPending}
              onReconnect={() => setTarget(connectorTarget(connector))}
              onDisconnect={() => {
                void disconnect(connector);
              }}
            />
          ))}
        </ConnectorShelf>
      ) : null}

      {shelves.map((shelf) => (
        <ConnectorShelf key={shelf.category} title={t(CATEGORY_LABELS[shelf.category])}>
          {shelf.presets.map((preset) => (
            <PresetRow
              key={preset.id}
              preset={preset}
              onSelect={() => setTarget(presetTarget(preset))}
            />
          ))}
        </ConnectorShelf>
      ))}

      {query.length > 0 && visibleConnectors.length === 0 && shelves.length === 0 ? (
        <SettingsEmptyState>
          {t("settings:connectorsNoMatches", { query: deferredSearch.trim() })}
        </SettingsEmptyState>
      ) : null}

      <p className="px-3 text-ui-sm text-muted-foreground">
        {t("settings:connectorsAvailability")}
      </p>

      <AddCustomConnectorDialog open={addOpen} onOpenChange={setAddOpen} onSubmit={addCustom} />
      <McpConnectorConnectDialog
        target={target}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        onConnected={onConnected}
      />
    </div>
  );
}
