// FILE: DebugFeatureFlagsMenu.tsx
// Purpose: Keeps local-only feature flag controls reusable without showing them in the product sidebar.
// Exports: DebugFeatureFlagsMenu

import { FlagIcon } from "~/lib/icons";
import {
  FEATURE_FLAGS,
  setFeatureFlagEnabled,
  useFeatureFlags,
  type ToggleFeatureFlagId,
} from "../featureFlags";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { SidebarMenuButton } from "./ui/sidebar";
import { toastManager } from "./ui/toast";

// Triggers local-only toast scenarios that are awkward to reproduce through real Git failures.
function triggerActionFailedToasts(values: Record<ToggleFeatureFlagId, boolean>): void {
  const copyText =
    "Error: Git command failed in /Users/ibrahime/Documents/Projects/dpcode\n\n" +
    "Command: git push upstream main\n" +
    "fatal: unable to access upstream remote for local debug toast preview";
  const toastData = {
    copyText,
    ...(values["persist-action-failed-debug-toasts"] ? {} : { dismissAfterVisibleMs: 30_000 }),
  };

  toastManager.add({
    type: "error",
    title: "Action failed",
    description: "Error: Git command failed in /Users/ibrahime/Documents/Projects/dpcode",
    data: toastData,
  });
  toastManager.add({
    type: "error",
    title: "Action failed",
    description: "Error: Git command failed in /Users/ibrahime/Documents/Projects/dpcode",
    data: toastData,
  });
}

export function DebugFeatureFlagsMenu() {
  const values = useFeatureFlags();

  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuButton
            size="default"
            className="h-8 flex-1 gap-2.5 rounded-lg px-2 text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/72 hover:bg-[var(--sidebar-accent)]"
          />
        }
      >
        <FlagIcon className="size-[15px]" />
        <span>Feature flags</span>
      </MenuTrigger>
      <MenuPopup
        align="start"
        side="top"
        className="min-w-72 rounded-lg border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] shadow-lg"
      >
        <MenuGroup>
          <MenuGroupLabel>Local feature flags</MenuGroupLabel>
          {FEATURE_FLAGS.map((flag) => {
            if (flag.kind === "action") {
              return (
                <MenuItem
                  key={flag.id}
                  onClick={() => triggerActionFailedToasts(values)}
                  className="py-2"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span>{flag.label}</span>
                    <span className="text-[length:var(--app-font-size-ui-xs,10px)] leading-4 text-muted-foreground/70">
                      {flag.description}
                    </span>
                  </div>
                </MenuItem>
              );
            }

            return (
              <MenuCheckboxItem
                key={flag.id}
                checked={values[flag.id]}
                onCheckedChange={(checked) => {
                  setFeatureFlagEnabled(flag.id, Boolean(checked));
                }}
                variant="switch"
                className="py-2"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span>{flag.label}</span>
                  <span className="text-[length:var(--app-font-size-ui-xs,10px)] leading-4 text-muted-foreground/70">
                    {flag.description}
                  </span>
                </div>
              </MenuCheckboxItem>
            );
          })}
        </MenuGroup>
        <MenuSeparator />
        <div className="px-2 py-1.5 text-[length:var(--app-font-size-ui-xs,10px)] leading-4 text-muted-foreground/58">
          Stored only in this browser profile.
        </div>
      </MenuPopup>
    </Menu>
  );
}
