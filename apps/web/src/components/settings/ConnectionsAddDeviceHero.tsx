// FILE: ConnectionsAddDeviceHero.tsx
// Purpose: The decorative band above the Add a device dialog: the phone screen a
//          scan opens, the other computer's Add button, or the two devices linked.
// Layer: Settings UI components
// Exports: ConnectionsAddDeviceHero, AddDeviceHeroVariant

import type { CSSProperties, ReactNode } from "react";

import { CheckIcon, DeviceComputerIcon, DeviceMobileIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export type AddDeviceHeroVariant = "phone" | "computer" | "linked";

// A faint dot grid with a soft sky glow where the illustration stands.
const HERO_BACKGROUND: CSSProperties = {
  backgroundImage:
    "radial-gradient(circle at 50% 120%, color-mix(in srgb, var(--color-sky-400) 14%, transparent), transparent 62%), radial-gradient(color-mix(in srgb, var(--foreground) 8%, transparent) 1px, transparent 1.3px)",
  backgroundSize: "100% 100%, 14px 14px",
};

const DEVICE_SHADOW_CLASS_NAME =
  "shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)]";

export function ConnectionsAddDeviceHero({
  variant,
  computerNoun,
}: {
  variant: AddDeviceHeroVariant;
  computerNoun: string;
}) {
  return (
    <div
      aria-hidden
      className="relative h-40 shrink-0 overflow-hidden bg-muted/60 select-none"
      style={HERO_BACKGROUND}
    >
      {variant === "phone" ? <PhoneScreen computerNoun={computerNoun} /> : null}
      {variant === "computer" ? <SettingsWindow computerNoun={computerNoun} /> : null}
      {variant === "linked" ? <LinkedDevices /> : null}
    </div>
  );
}

function PhoneScreen({ computerNoun }: { computerNoun: string }) {
  return (
    <div
      className={cn(
        "absolute top-6 left-1/2 h-60 w-44 -translate-x-1/2 rounded-[34px] bg-[color-mix(in_srgb,var(--foreground)_14%,var(--popover))] p-1.5",
        DEVICE_SHADOW_CLASS_NAME,
      )}
    >
      <div className="flex h-full flex-col items-center rounded-[28px] bg-popover px-3.5 py-2.5">
        <span className="h-4 w-14 rounded-full bg-black" />
        <span className="mt-3 flex size-8.5 items-center justify-center rounded-[10px] bg-secondary text-foreground">
          <DeviceComputerIcon className="size-4.5" />
        </span>
        <p className="mt-2.5 text-center text-ui-sm leading-tight font-semibold text-foreground">
          Connect to your {computerNoun}?
        </p>
        <p className="mt-1 text-center text-ui-timestamp leading-snug text-muted-foreground">
          Synara on this phone will control it.
        </p>
      </div>
    </div>
  );
}

function SettingsWindow({ computerNoun }: { computerNoun: string }) {
  return (
    <div
      className={cn(
        "absolute top-6.5 left-1/2 flex h-48 w-80 -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover",
        DEVICE_SHADOW_CLASS_NAME,
      )}
    >
      <div className="flex h-5.5 shrink-0 items-center gap-1.25 px-2.25">
        <WindowDot />
        <WindowDot />
        <WindowDot />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-24 flex-col gap-0.5 bg-muted/50 px-1.5 py-1 text-ui-timestamp text-muted-foreground">
          <SidebarItem>General</SidebarItem>
          <SidebarItem>Appearance</SidebarItem>
          <SidebarItem active>Connections</SidebarItem>
          <SidebarItem>Agent providers</SidebarItem>
          <SidebarItem>Models &amp; writing</SidebarItem>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 px-3 py-2">
          <span className="text-ui-xs font-semibold text-foreground">Connections</span>
          <div className="flex gap-0.5 rounded-full bg-secondary p-0.5 text-ui-timestamp">
            <span className="flex-1 py-0.75 text-center text-muted-foreground">
              Control this {computerNoun}
            </span>
            <span className="flex-1 rounded-full bg-popover py-0.75 text-center text-foreground shadow-xs">
              Control other devices
            </span>
          </div>
          <div className="flex items-center justify-between pt-1">
            <span className="text-ui-timestamp text-muted-foreground">Computers</span>
            <span className="rounded-full bg-primary px-2.25 py-0.75 text-ui-timestamp font-semibold text-primary-foreground ring-2 ring-sky-500/70 ring-offset-2 ring-offset-popover dark:ring-sky-400/70">
              Add
            </span>
          </div>
          <span className="h-px bg-border" />
          <span className="h-1.25 w-[70%] rounded-full bg-secondary" />
          <span className="h-1.25 w-[48%] rounded-full bg-secondary" />
        </div>
      </div>
    </div>
  );
}

function WindowDot() {
  return <span className="size-1.75 rounded-full bg-foreground/15" />;
}

function SidebarItem({ active = false, children }: { active?: boolean; children: ReactNode }) {
  return (
    <span className={cn("rounded-[5px] px-1.5 py-1", active && "bg-secondary text-foreground")}>
      {children}
    </span>
  );
}

function LinkedDevices() {
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-3.5">
      <DeviceTile>
        <DeviceMobileIcon className="size-7" />
      </DeviceTile>
      <div className="flex items-center gap-1.5">
        <span className="size-1 rounded-full bg-muted-foreground/50" />
        <span className="flex size-6.5 items-center justify-center rounded-full bg-sky-500 text-white dark:bg-sky-400 dark:text-popover">
          <CheckIcon className="size-3.5" />
        </span>
        <span className="size-1 rounded-full bg-muted-foreground/50" />
      </div>
      <DeviceTile>
        <DeviceComputerIcon className="size-7" />
      </DeviceTile>
    </div>
  );
}

function DeviceTile({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-16 items-center justify-center rounded-[18px] border border-border bg-popover text-foreground">
      {children}
    </span>
  );
}
