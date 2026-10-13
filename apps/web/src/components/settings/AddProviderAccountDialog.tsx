// FILE: AddProviderAccountDialog.tsx
// Purpose: Collects what a new provider account needs — which provider it runs, its
//   label, the routing id derived from that label, an accent, and its own paths.
// Layer: Settings UI components
// Depends on: dialog primitives, settings select control, account presentation helpers.

import type { ProviderKind } from "@synara/contracts";
import { type FormEvent, useId, useState } from "react";

import {
  deriveProviderAccountId,
  validateProviderAccountId,
} from "~/lib/providerInstancePresentation";

import { ProviderIcon } from "../ProviderIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  dialogFieldLabelClassName,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SelectItem } from "../ui/select";
import { ProviderAccentColorControl } from "./ProviderAccentColorControl";
import { SettingsSelectControl } from "./SettingControls";
import { useTranslation } from "~/i18n";

export type AddProviderAccountConfigField = {
  /** Key written into the account's launch config. */
  readonly key: string;
  readonly label: string;
  readonly placeholder: string;
  readonly description?: string;
};

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
    }
  }

  const providerLabel =
    props.providers.find((option) => option.provider === provider)?.label ?? provider;
  const instanceId = idOverride ?? deriveProviderAccountId(provider, label);
  const idError = validateProviderAccountId(instanceId, props.existingIds);
  const configFields = props.configFieldsFor(provider);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (idError !== null) return;
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
          <DialogTitle>{t("Add account")}</DialogTitle>
          <DialogDescription>
            {t("Each account signs in on its own and gets its own tab in the model picker.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="space-y-3" onSubmit={submit} noValidate>
            <div className="space-y-1">
              <span className={dialogFieldLabelClassName}>{t("Provider")}</span>
              <SettingsSelectControl
                value={provider}
                onValueChange={(next) => setProvider(next as ProviderKind)}
                ariaLabel={t("Provider")}
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
            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>{t("Label")}</span>
              <Input
                size="sm"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("e.g. Work")}
                spellCheck={false}
                autoFocus
              />
              <span className="block text-ui-sm text-muted-foreground">
                {t("Shown in the account list and the model picker. Optional.")}
              </span>
            </label>
            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>{t("Account ID")}</span>
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
                  : t("Routing key used by threads and sessions. Letters, digits, '-', or '_'.")}
              </span>
            </label>
            <div className="space-y-1">
              <span className={dialogFieldLabelClassName}>{t("Accent color")}</span>
              <ProviderAccentColorControl
                value={accentColor}
                onChange={setAccentColor}
                accountLabel={label.trim() || "the new account"}
              />
              <span className="block text-ui-sm text-muted-foreground">
                {t("Optional. Shows as a dot on the account's icon in the picker.")}
              </span>
            </div>
            {configFields.map((field) => (
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
                />
                {field.description ? (
                  <span className="block text-ui-sm text-muted-foreground">
                    {field.description}
                  </span>
                ) : null}
              </label>
            ))}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button type="submit" form={formId}>
            {t("Add account")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
