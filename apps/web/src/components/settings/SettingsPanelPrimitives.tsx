// FILE: SettingsPanelPrimitives.tsx
// Purpose: Shared settings section card and row primitives (Codex-style bordered groups).
// Layer: Settings UI components
// Exports: SettingsSection, SettingsRow, SettingsSelectPopup

import { type ComponentProps, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import {
  SETTINGS_CARD_CLASS_NAME,
  SETTINGS_CARD_ROW_CLASS_NAME,
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
  SETTINGS_PANEL_SECTION_CLASS_NAME,
  SETTINGS_SECTION_LABEL_CLASS_NAME,
} from "~/settingsPanelStyles";
import { SelectPopup } from "~/components/ui/select";
import { composerPickerMenuShellClassName } from "~/components/chat/composerPickerSize";

const settingsCardClassName = cn(
  SETTINGS_CARD_CLASS_NAME,
  "divide-y divide-[color:var(--color-border)]",
);

export function SettingsCard({ children }: { children: ReactNode }) {
  return <div className={settingsCardClassName}>{children}</div>;
}

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={SETTINGS_PANEL_SECTION_CLASS_NAME}>
      <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>{title}</h2>
      <SettingsCard>{children}</SettingsCard>
    </section>
  );
}

/** Frosted select dropdown panel with settings `rounded-lg` chrome. */
export function SettingsSelectPopup({
  align = "end",
  alignItemWithTrigger = false,
  shellClassName,
  ...props
}: ComponentProps<typeof SelectPopup>) {
  return (
    <SelectPopup
      align={align}
      alignItemWithTrigger={alignItemWithTrigger}
      surface="settings"
      shellClassName={cn(composerPickerMenuShellClassName(), shellClassName)}
      {...props}
    />
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
  onClick,
}: {
  title: ReactNode;
  description: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div className={SETTINGS_CARD_ROW_CLASS_NAME} data-slot="settings-row">
      <div
        className={cn(
          "flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between",
          onClick && "cursor-pointer",
        )}
        onClick={onClick}
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          <p className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>{description}</p>
          {status ? <div className="pt-1 text-[11px] text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
