// FILE: AddProviderAccountDialog.tsx
// Purpose: Collects what a new provider account needs — which provider it runs, its
//   label, the routing id derived from that label, an accent, and its own paths.
// Layer: Settings UI components
// Depends on: dialog primitives, settings select control, account presentation helpers.

import type { AcpRegistryAgentDescriptor, ProviderKind } from "@synara/contracts";
import { type FormEvent, useEffect, useId, useState } from "react";

import {
  deriveProviderAccountId,
  validateProviderAccountId,
} from "~/lib/providerInstancePresentation";
import { acpArgsToText } from "~/lib/acpAgentConfigText";
import { ensureNativeApi } from "~/nativeApi";

import { CircleCheckIcon, TriangleAlertIcon } from "~/lib/icons";
import { ProviderIcon } from "../../ProviderIcon";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  dialogFieldLabelClassName,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { SelectItem } from "../../ui/select";
import { ProviderAccentColorControl } from "./ProviderAccentColorControl";
import { SettingsSelectControl } from "../SettingControls";
import { useTranslation } from "~/i18n";

export type AddProviderAccountConfigField = {
  /** Key written into the account's launch config. */
  readonly key: string;
  readonly label: string;
  readonly placeholder: string;
  readonly description?: string;
  /** The account cannot be added while this field is empty. */
  readonly required?: boolean;
};

// The ACP add flow offers the curated agent registry next to a manual command,
// like the "Install from Registry" pickers other ACP clients expose.
const ACP_CUSTOM_AGENT = "__custom__";

export type AddProviderAccountInput = {
  readonly provider: ProviderKind;
  readonly instanceId: string;
  readonly displayName: string;
  readonly accentColor: string | undefined;
  /** Only the config fields the user filled in. */
  readonly config: Readonly<Record<string, string>>;
};

export function AddProviderAccountDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: ReadonlyArray<{ readonly provider: ProviderKind; readonly label: string }>;
  initialProvider: ProviderKind;
  /** Every account id already in use, across providers. */
  existingIds: ReadonlySet<string>;
  configFieldsFor: (provider: ProviderKind) => ReadonlyArray<AddProviderAccountConfigField>;
  onAdd: (input: AddProviderAccountInput) => void;
}) {
  const { t } = useTranslation();

  const formId = useId();
  const [provider, setProvider] = useState(props.initialProvider);
  const [label, setLabel] = useState("");
  // Null while the id still follows the label; typing in the field detaches it for good.
  const [idOverride, setIdOverride] = useState<string | null>(null);
  const [accentColor, setAccentColor] = useState<string | undefined>(undefined);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [registryAgents, setRegistryAgents] =
    useState<ReadonlyArray<AcpRegistryAgentDescriptor> | null>(null);
  const [registryRunners, setRegistryRunners] = useState<{
    npx: boolean;
    uvx: boolean;
  } | null>(null);
  const [registrySelection, setRegistrySelection] = useState<string>(ACP_CUSTOM_AGENT);
  const [installingAgentId, setInstallingAgentId] = useState<string | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  // Live PATH check for the custom agent's launch command.
  const [commandResolution, setCommandResolution] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "checking" }
    | { readonly kind: "found"; readonly path: string }
    | { readonly kind: "missing" }
  >({ kind: "idle" });

  // Start from a blank form every time the dialog opens.
  const [wasOpen, setWasOpen] = useState(props.open);
  if (wasOpen !== props.open) {
    setWasOpen(props.open);
    if (props.open) {
      setProvider(props.initialProvider);
      setLabel("");
      setIdOverride(null);
      setAccentColor(undefined);
      setConfig({});
      setSubmitAttempted(false);
      setRegistryAgents(null);
      setRegistryRunners(null);
      setRegistrySelection(ACP_CUSTOM_AGENT);
      setInstallingAgentId(null);
      setRegistryError(null);
      setCommandResolution({ kind: "idle" });
    }
  }

  useEffect(() => {
    if (!props.open || provider !== "acp" || registryAgents !== null) return;
    let cancelled = false;
    ensureNativeApi()
      .provider.listAcpRegistryAgents()
      .then(
        (result) => {
          if (cancelled) return;
          setRegistryAgents(result.agents);
          if (result.runners) setRegistryRunners(result.runners);
        },
        (error) => {
          if (!cancelled) {
            setRegistryAgents([]);
            setRegistryError(error instanceof Error ? error.message : String(error));
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [props.open, provider, registryAgents]);

  const launchCommand = (config.command ?? "").trim();
  useEffect(() => {
    if (provider !== "acp" || !props.open || launchCommand.length === 0) {
      setCommandResolution({ kind: "idle" });
      return;
    }
    setCommandResolution({ kind: "checking" });
    let cancelled = false;
    const timer = setTimeout(() => {
      ensureNativeApi()
        .provider.resolveExecutable({ command: launchCommand })
        .then(
          (result) => {
            if (cancelled) return;
            setCommandResolution(
              result.resolvedPath
                ? { kind: "found", path: result.resolvedPath }
                : { kind: "missing" },
            );
          },
          () => {
            if (!cancelled) setCommandResolution({ kind: "missing" });
          },
        );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [props.open, provider, launchCommand]);

  const selectRegistryAgent = async (agent: AcpRegistryAgentDescriptor) => {
    setRegistrySelection(agent.id);
    setRegistryError(null);
    setLabel(agent.name);
    setIdOverride(`acp_${agent.id}`);
    // The user's own install on PATH wins over a managed download or npx.
    if (agent.availability?.state === "on-path" && agent.availability.path) {
      setConfig((current) => ({
        ...current,
        command: agent.availability!.path!,
        args: acpArgsToText(agent.launch.args ?? []),
      }));
      return;
    }
    if (agent.launch.kind !== "binary") {
      setConfig((current) => ({
        ...current,
        command: agent.launch.command ?? "",
        args: acpArgsToText(agent.launch.args ?? []),
      }));
      return;
    }
    setInstallingAgentId(agent.id);
    try {
      const installed = await ensureNativeApi().provider.installAcpRegistryAgent({
        agentId: agent.id,
      });
      setConfig((current) => ({
        ...current,
        command: installed.command,
        args: acpArgsToText(installed.args),
      }));
    } catch (error) {
      setRegistryError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingAgentId(null);
    }
  };

  const providerLabel =
    props.providers.find((option) => option.provider === provider)?.label ?? provider;
  const instanceId = idOverride ?? deriveProviderAccountId(provider, label);
  const idError = validateProviderAccountId(instanceId, props.existingIds);
  const configFields = props.configFieldsFor(provider);
  const acpCommandField =
    provider === "acp" ? configFields.find((field) => field.key === "command") : undefined;
  const acpArgsField =
    provider === "acp" ? configFields.find((field) => field.key === "args") : undefined;
  const acpCommandInvalid =
    submitAttempted && acpCommandField?.required === true && launchCommand.length === 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (idError !== null) return;
    if (
      configFields.some(
        (field) => field.required === true && (config[field.key] ?? "").trim().length === 0,
      )
    ) {
      return;
    }
    const filledConfig: Record<string, string> = {};
    for (const field of configFields) {
      const value = config[field.key]?.trim();
      if (value) filledConfig[field.key] = value;
    }
    props.onAdd({
      provider,
      instanceId: instanceId.trim(),
      displayName: label.trim(),
      accentColor,
      config: filledConfig,
    });
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings:addAccount")}</DialogTitle>
          <DialogDescription>{t("settings:eachAccountSignsInOnItsOwnAndGets")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="space-y-3" onSubmit={submit} noValidate>
            <div className="space-y-1">
              <span className={dialogFieldLabelClassName}>
                {t("workspace:models_customModelProvider")}
              </span>
              <SettingsSelectControl
                value={provider}
                onValueChange={(next) => setProvider(next as ProviderKind)}
                ariaLabel={t("workspace:models_customModelProvider")}
                triggerClassName="w-full"
                valueContent={
                  <span className="flex items-center gap-2">
                    <ProviderIcon provider={provider} className="size-4 shrink-0" />
                    <span className="truncate">{providerLabel}</span>
                  </span>
                }
              >
                {props.providers.map((option) => (
                  <SelectItem hideIndicator key={option.provider} value={option.provider}>
                    <span className="flex items-center gap-2">
                      <ProviderIcon provider={option.provider} className="size-4 shrink-0" />
                      <span className="truncate">{option.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SettingsSelectControl>
            </div>
            {provider === "acp" ? (
              <div className="space-y-1">
                <span className={dialogFieldLabelClassName}>{t("settings:acpRegistryAgent")}</span>
                <SettingsSelectControl
                  value={registrySelection}
                  onValueChange={(next) => {
                    if (next === ACP_CUSTOM_AGENT) {
                      setRegistrySelection(ACP_CUSTOM_AGENT);
                      setRegistryError(null);
                      return;
                    }
                    const agent = registryAgents?.find((entry) => entry.id === next);
                    if (agent) void selectRegistryAgent(agent);
                  }}
                  ariaLabel={t("settings:acpRegistryAgent")}
                  triggerClassName="w-full"
                  valueContent={
                    <span className="flex items-center gap-2">
                      <span className="truncate">
                        {registrySelection === ACP_CUSTOM_AGENT
                          ? t("settings:acpRegistryCustomAgent")
                          : (registryAgents?.find((agent) => agent.id === registrySelection)
                              ?.name ?? registrySelection)}
                      </span>
                    </span>
                  }
                >
                  <SelectItem hideIndicator value={ACP_CUSTOM_AGENT}>
                    {t("settings:acpRegistryCustomAgent")}
                  </SelectItem>
                  {registryAgents?.map((agent) => (
                    <SelectItem
                      hideIndicator
                      key={agent.id}
                      value={agent.id}
                      disabled={!agent.launch.installable}
                    >
                      <span className="flex items-center gap-2">
                        {agent.icon ? (
                          <img src={agent.icon} alt="" className="size-4 shrink-0" />
                        ) : null}
                        <span className="truncate">{agent.name}</span>
                        <span className="truncate text-muted-foreground">{agent.version}</span>
                        {agent.availability?.state === "installed" ? (
                          <CircleCheckIcon className="size-3.5 shrink-0 text-success" />
                        ) : null}
                        {agent.availability?.state === "update-available" ? (
                          <span className="shrink-0 text-muted-foreground">
                            {t("settings:acpRegistryUpdateAvailable")}
                          </span>
                        ) : null}
                        {agent.availability?.state === "on-path" ? (
                          <span className="shrink-0 text-muted-foreground">
                            {t("settings:acpRegistryOnPath")}
                          </span>
                        ) : null}
                        {agent.launch.kind === "npx" && registryRunners?.npx === false ? (
                          <span className="shrink-0 text-warning">
                            {t("settings:acpRegistryNeedsNpx")}
                          </span>
                        ) : null}
                        {agent.launch.kind === "uvx" && registryRunners?.uvx === false ? (
                          <span className="shrink-0 text-warning">
                            {t("settings:acpRegistryNeedsUvx")}
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SettingsSelectControl>
                <span className="block text-ui-sm text-muted-foreground">
                  {installingAgentId !== null
                    ? t("settings:acpRegistryInstalling")
                    : registryError !== null
                      ? registryError
                      : registryAgents === null
                        ? t("settings:acpRegistryLoading")
                        : t("settings:acpRegistryHint")}
                </span>
              </div>
            ) : null}
            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>
                {t("chat:pinned_renamePlaceholder")}
              </span>
              <Input
                size="sm"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("settings:eGWork")}
                spellCheck={false}
                autoFocus
              />
              <span className="block text-ui-sm text-muted-foreground">
                {t("settings:shownInTheAccountListAndTheModelPicker")}
              </span>
            </label>
            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>{t("settings:accountID")}</span>
              <Input
                size="sm"
                className="font-mono"
                value={instanceId}
                onChange={(event) => setIdOverride(event.target.value)}
                placeholder={deriveProviderAccountId(provider, "work")}
                spellCheck={false}
                aria-invalid={submitAttempted && idError !== null}
              />
              <span
                className={
                  submitAttempted && idError !== null
                    ? "block text-ui-sm text-destructive"
                    : "block text-ui-sm text-muted-foreground"
                }
              >
                {submitAttempted && idError !== null
                  ? idError
                  : t("settings:routingKeyUsedByThreadsAndSessionsLettersDigits")}
              </span>
            </label>
            <div className="space-y-1">
              <span className={dialogFieldLabelClassName}>{t("settings:accentColor")}</span>
              <ProviderAccentColorControl
                value={accentColor}
                onChange={setAccentColor}
                accountLabel={label.trim() || "the new account"}
              />
              <span className="block text-ui-sm text-muted-foreground">
                {t("settings:optionalShowsAsADotOnTheAccountS")}
              </span>
            </div>
            {provider === "acp" ? (
              <div className="space-y-3">
                <label className="block space-y-1">
                  <span className={dialogFieldLabelClassName}>{acpCommandField?.label}</span>
                  <Input
                    size="sm"
                    className="font-mono"
                    value={config.command ?? ""}
                    onChange={(event) =>
                      setConfig((current) => ({ ...current, command: event.target.value }))
                    }
                    placeholder={acpCommandField?.placeholder}
                    spellCheck={false}
                    aria-invalid={acpCommandInvalid}
                  />
                  {acpCommandInvalid ? (
                    <span className="block text-ui-sm text-destructive">
                      {t("settings:fieldRequired", {
                        field: acpCommandField?.label ?? "",
                      })}
                    </span>
                  ) : commandResolution.kind === "checking" ? (
                    <span className="block text-ui-sm text-muted-foreground">
                      {t("settings:acpCommandChecking")}
                    </span>
                  ) : commandResolution.kind === "found" ? (
                    <span className="flex items-center gap-1.5 text-ui-sm text-muted-foreground">
                      <CircleCheckIcon className="size-3.5 shrink-0" />
                      <span className="truncate">
                        {t("settings:acpCommandResolved", { path: commandResolution.path })}
                      </span>
                    </span>
                  ) : commandResolution.kind === "missing" ? (
                    <span className="flex items-center gap-1.5 text-ui-sm text-warning">
                      <TriangleAlertIcon className="size-3.5 shrink-0" />
                      {t("settings:acpCommandNotFound")}
                    </span>
                  ) : (
                    <span className="block text-ui-sm text-muted-foreground">
                      {acpCommandField?.description}
                    </span>
                  )}
                </label>
                <label className="block space-y-1">
                  <span className={dialogFieldLabelClassName}>{acpArgsField?.label}</span>
                  <Input
                    size="sm"
                    className="font-mono"
                    value={config.args ?? ""}
                    onChange={(event) =>
                      setConfig((current) => ({ ...current, args: event.target.value }))
                    }
                    placeholder={acpArgsField?.placeholder}
                    spellCheck={false}
                  />
                  <span className="block text-ui-sm text-muted-foreground">
                    {acpArgsField?.description}
                  </span>
                </label>
                {launchCommand.length > 0 ? (
                  <div className="space-y-1">
                    <span className={dialogFieldLabelClassName}>
                      {t("settings:acpLaunchPreview")}
                    </span>
                    <code className="block truncate rounded-md border border-border/70 bg-background/60 px-2.5 py-1.5 font-mono text-ui-sm">
                      {launchCommand}
                      {(config.args ?? "").trim().length > 0
                        ? ` ${(config.args ?? "").trim()}`
                        : ""}
                    </code>
                  </div>
                ) : null}
              </div>
            ) : (
              configFields.map((field) => {
                const fieldEmpty = (config[field.key] ?? "").trim().length === 0;
                const fieldInvalid = submitAttempted && field.required === true && fieldEmpty;
                return (
                  <label key={`${provider}:${field.key}`} className="block space-y-1">
                    <span className={dialogFieldLabelClassName}>{field.label}</span>
                    <Input
                      size="sm"
                      value={config[field.key] ?? ""}
                      onChange={(event) =>
                        setConfig((current) => ({ ...current, [field.key]: event.target.value }))
                      }
                      placeholder={field.placeholder}
                      spellCheck={false}
                      aria-invalid={fieldInvalid}
                    />
                    {fieldInvalid ? (
                      <span className="block text-ui-sm text-destructive">
                        {t("settings:fieldRequired", { field: field.label })}
                      </span>
                    ) : field.description ? (
                      <span className="block text-ui-sm text-muted-foreground">
                        {field.description}
                      </span>
                    ) : null}
                  </label>
                );
              })
            )}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("common:form_cancel")}
          </Button>
          <Button type="submit" form={formId}>
            {t("settings:addAccount")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
