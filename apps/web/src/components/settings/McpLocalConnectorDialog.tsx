import type { McpConnector } from "@synara/contracts";
import {
  isMcpLoopbackHostname,
  normalizeMcpConnectorUrl,
  type McpConnectorUrlReasonCode,
} from "@synara/shared/mcpConnectors";
import { useMutation } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { useTranslation } from "~/i18n";
import { ensureNativeApi } from "~/nativeApi";

export const MCP_CONNECTOR_URL_REASON_KEYS: Record<McpConnectorUrlReasonCode, string> = {
  required: "settings:connectorUrlRequired",
  "too-long": "settings:connectorUrlTooLong",
  invalid: "settings:connectorUrlInvalid",
  "https-required": "settings:remote_connector_httpsOrLoopbackRequired",
  credentials: "settings:connectorUrlCredentials",
  "public-host": "settings:connectorUrlPublicHost",
};

// Protocol examples stay exact in every interface language.
const ARGUMENTS_EXAMPLE = '["mcp"]';
const ENVIRONMENT_EXAMPLE = '{"API_KEY":"…"}';

export function McpLocalConnectorDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUrl: (url: string) => void;
  onConnected: (connector: McpConnector) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [mode, setMode] = useState<"url" | "stdio">("url");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [cwd, setCwd] = useState("");
  const [env, setEnv] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      let parsedArgs: unknown;
      let parsedEnv: unknown;
      try {
        parsedArgs = JSON.parse(args);
        parsedEnv = env ? JSON.parse(env) : {};
      } catch {
        throw new Error(t("settings:remote_connector_invalidJson"));
      }
      if (!Array.isArray(parsedArgs) || !parsedArgs.every((value) => typeof value === "string"))
        throw new Error(t("settings:remote_connector_invalidArguments"));
      if (
        !parsedEnv ||
        typeof parsedEnv !== "object" ||
        Array.isArray(parsedEnv) ||
        !Object.values(parsedEnv).every((value) => typeof value === "string")
      )
        throw new Error(t("settings:remote_connector_invalidEnvironment"));
      return ensureNativeApi().server.connectMcpConnector({
        name,
        command,
        args: parsedArgs as string[],
        env: parsedEnv as Record<string, string>,
        ...(cwd.trim() ? { cwd } : {}),
      });
    },
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mode === "url") {
      const normalized = normalizeMcpConnectorUrl(url);
      if (!normalized.ok) {
        setError(
          normalized.reasonCode
            ? t(MCP_CONNECTOR_URL_REASON_KEYS[normalized.reasonCode])
            : normalized.reason,
        );
        return;
      }
      if (!isMcpLoopbackHostname(new URL(normalized.url).hostname)) {
        setError(t("settings:remote_connector_localAddressRequired"));
        return;
      }
      props.onUrl(normalized.url);
      return;
    }
    try {
      const result = await mutation.mutateAsync();
      if (result.connector) {
        setEnv("");
        props.onConnected(result.connector);
        props.onOpenChange(false);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("settings:remote_connector_addLocalFailed"),
      );
    }
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          setEnv("");
          setError(null);
        }
        props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings:remote_connector_addLocal")}</DialogTitle>
          <DialogDescription>
            {t("settings:remote_connector_addLocalDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="space-y-3 text-ui" onSubmit={(event) => void submit(event)}>
            <label className="block">
              {t("settings:remote_connector_transport")}
              <select
                aria-label={t("settings:remote_connector_localTransport")}
                value={mode}
                className="ml-2 rounded border bg-background p-1 text-ui"
                onChange={(event) => setMode(event.target.value as "url" | "stdio")}
              >
                <option value="url">{t("settings:remote_connector_localHttpUrl")}</option>
                <option value="stdio">{t("settings:remote_connector_stdioCommand")}</option>
              </select>
            </label>
            {mode === "url" ? (
              <Input
                aria-label={t("settings:remote_connector_localMcpUrl")}
                placeholder="http://127.0.0.1:29979/mcp"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required
              />
            ) : (
              <>
                <label className="block">
                  {t("common:scripts_name")}
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={60}
                  />
                </label>
                <label className="block">
                  {t("workspace:scripts_command")}
                  <Input
                    value={command}
                    placeholder="~/.paper/bin/paper"
                    onChange={(event) => setCommand(event.target.value)}
                    required
                  />
                </label>
                <label className="block">
                  {t("settings:remote_connector_jsonArguments")}
                  <Input
                    value={args}
                    placeholder={ARGUMENTS_EXAMPLE}
                    onChange={(event) => setArgs(event.target.value)}
                    required
                  />
                </label>
                <label className="block">
                  {t("settings:remote_connector_workingDirectory")}
                  <Input
                    value={cwd}
                    placeholder={t("settings:remote_connector_homeDirectory")}
                    onChange={(event) => setCwd(event.target.value)}
                  />
                </label>
                <label className="block">
                  {t("settings:remote_connector_jsonEnvironment")}
                  <Input
                    type="password"
                    autoComplete="off"
                    value={env}
                    placeholder={ENVIRONMENT_EXAMPLE}
                    onChange={(event) => setEnv(event.target.value)}
                  />
                </label>
                <p className="text-ui-sm text-muted-foreground">
                  {t("settings:remote_connector_runCommandNotice")}
                </p>
              </>
            )}
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setEnv("");
              setError(null);
              props.onOpenChange(false);
            }}
          >
            {t("common:form_cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={mutation.isPending}>
            {mode === "stdio" ? t("settings:remote_connector_addAndRun") : t("git:continue")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
