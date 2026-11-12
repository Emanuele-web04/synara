// FILE: ProviderAccountRuntimeFields.tsx
// Purpose: The Runtime band of a secondary account's editor: its terminal command, the
//          launch paths it keeps in its own config, and the Advanced disclosure with the
//          command override and rarely touched launch details.
// Layer: Settings UI
// Exports: ProviderAccountRuntimeFields

import { normalizeProviderCliAlias } from "@synara/shared/providerCliProfiles";
import { useState, type ReactNode } from "react";

import type { ManageableProviderInstance } from "~/appSettings";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTranslation } from "~/i18n";
import { CopyIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { DisclosureChevron } from "../../ui/DisclosureChevron";
import { Switch } from "../../ui/switch";
import { DebouncedSettingTextInput } from "../DebouncedSettingTextInput";
import {
  providerInstanceConfigKey,
  type ProviderInstallField,
  type ProviderInstallSettings,
} from "../providers/providerInstallSettings";
import type { providerInstanceUpdater } from "./providerAccountShared";

function readConfigString(config: unknown, key: string): string {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function readConfigBoolean(config: unknown, key: string): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  return (config as Record<string, unknown>)[key] === true;
}

// Launch details most accounts never touch; kept behind the editor's Advanced disclosure.
function isAdvancedField(field: ProviderInstallField): boolean {
  return (
    field.kind === "boolean" ||
    providerInstanceConfigKey(field) === "binaryPath" ||
    field.settingsKey === "claudeHomePath"
  );
}

export function ProviderAccountRuntimeFields(props: {
  config: ProviderInstallSettings;
  entry: ManageableProviderInstance;
  cliCommand: string;
  /** Another account already answers to this terminal command. */
  cliCommandConflicts: boolean;
  updateInstance: ReturnType<typeof providerInstanceUpdater>;
}) {
  const { t } = useTranslation();

  const provider = props.config.provider;
  const isAccountProvider = provider === "codex" || provider === "claudeAgent";
  const updateInstance = props.updateInstance;
  const cliCommand = props.cliCommand;
  const cliCommandConflicts = props.cliCommandConflicts;

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

  const entry = props.entry;
  const { instanceId, instance, legacyCodexAccountId } = entry;
  const cliAlias = readConfigString(instance.config, "cliAlias");
  const cliAliasInvalid = cliAlias.length > 0 && normalizeProviderCliAlias(cliAlias) === undefined;
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
              cliAliasInvalid || cliCommandConflicts ? "text-destructive" : "text-muted-foreground",
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
