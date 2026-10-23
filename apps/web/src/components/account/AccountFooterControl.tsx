// FILE: AccountFooterControl.tsx
// Purpose: The rail's account entry point — a signed-in avatar opening the
// account menu, or a signed-out user icon opening the local-mode menu. Settings
// lives inside both menus.
// Layer: Web account feature (sidebar footer).

import { useNavigate } from "@tanstack/react-router";
import { toastManager } from "~/components/ui/toast";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import {
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
  SidebarContextMenuIcon,
} from "~/components/sidebarContextMenuStyles";
import { SidebarIconButton } from "~/components/SidebarIconButton";
import { appRailButtonClassName } from "~/components/AppRail";
import { ProfileAvatar } from "@synara/profile-ui/avatar";
import { ExternalLinkIcon, GlobeIcon, SettingsIcon, UsageGaugeIcon, UserIcon } from "~/lib/icons";
import { openExternalLink } from "~/lib/linkChips";
import { isMacPlatform } from "~/lib/utils";
import { useAccount } from "~/hooks/useAccount";
import { accountErrorMessage, accountInitial, publicProfileUrl } from "~/lib/accountLogic";
import { PROFILE_AVATAR_COLORS } from "~/components/profile/useProfileAvatarColor";
import { useAccountDialogStore } from "./accountDialogStore";

const DEFAULT_MENU_AVATAR_COLOR = PROFILE_AVATAR_COLORS[0] ?? "#22c55e";

function settingsShortcutLabel(): string {
  return isMacPlatform(navigator.platform) ? "⌘," : "Ctrl+,";
}

export function AccountFooterControl() {
  const account = useAccount();
  return account.me ? <SignedInFooter /> : <SignedOutFooter />;
}

function SignedInFooter() {
  const account = useAccount();
  const navigate = useNavigate();
  const openSignIn = useAccountDialogStore((state) => state.openSignIn);
  const me = account.me;
  if (!me) return null;

  const profile = me.profile ?? null;
  const displayName = profile?.displayName ?? me.name;
  const avatarColor = profile?.avatarColor ?? DEFAULT_MENU_AVATAR_COLOR;
  // With a profile, its resolved avatarUrl is the one source of truth (it
  // already reflects the chosen source: uploaded object, provider picture,
  // or null for the initials placeholder). Pre-onboarding there is no
  // profile yet, so the provider picture is the best available image.
  const avatarImage = profile ? (profile.avatarUrl ?? null) : (me.image ?? null);

  const handleSignOut = async () => {
    try {
      await account.signOut.mutateAsync();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not sign out",
        description: accountErrorMessage(cause, "Try again in a moment."),
      });
    }
  };

  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={UserIcon}
        label={`Account: ${displayName}`}
        tooltip={displayName}
        tooltipSide="right"
        className={appRailButtonClassName(false)}
      >
        <ProfileAvatar
          initials={accountInitial(displayName)}
          color={avatarColor}
          image={avatarImage}
          className="size-7 shrink-0"
          textClassName="text-ui-xs"
        />
      </SidebarIconButton>
      <ComposerPickerMenuPopup side="right" align="end" className="w-64 min-w-64">
        <MenuGroup>
          <div className="flex flex-col gap-0.5 px-2 py-1.5">
            <span className="truncate text-ui font-medium text-foreground">{displayName}</span>
            <span className="truncate text-ui-sm text-muted-foreground">
              {profile ? `@${profile.handle} · ${me.email}` : me.email}
            </span>
          </div>
          {/* The workspace row is deliberately absent: host ownership is
              org-keyed server-side, but workspace switching is not a shipped
              surface yet — a single always-checked row reads as a selector
              that goes nowhere. Reintroduce it when multi-workspace ships. */}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuItem
            className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
            onClick={() => void navigate({ to: "/settings", search: { section: "usage" } })}
          >
            <SidebarContextMenuIcon icon={UsageGaugeIcon} />
            <span>Usage</span>
          </MenuItem>
          {/* Three honest states: a public profile links to its live page, a
              private one routes to the visibility setting (the page would
              404), and no profile resumes onboarding. */}
          {profile ? (
            profile.public ? (
              <MenuItem
                className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() => openExternalLink(publicProfileUrl(profile.handle))}
              >
                <SidebarContextMenuIcon icon={ExternalLinkIcon} />
                <span>View public profile</span>
              </MenuItem>
            ) : (
              <MenuItem
                className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() => void navigate({ to: "/settings", search: { section: "profile" } })}
              >
                <SidebarContextMenuIcon icon={GlobeIcon} />
                <span>Make profile public…</span>
              </MenuItem>
            )
          ) : (
            <MenuItem className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME} onClick={openSignIn}>
              <SidebarContextMenuIcon icon={ExternalLinkIcon} />
              <span>Finish setting up</span>
            </MenuItem>
          )}
          {/* Hosts are an account concept (ADR 0002 — they follow the owner),
              so the account menu is where they belong; the signed-out menu
              deliberately has no equivalent. */}
          <MenuItem
            className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
            onClick={() => void navigate({ to: "/settings", search: { section: "connections" } })}
          >
            <SidebarContextMenuIcon icon={GlobeIcon} />
            <span>Connections</span>
          </MenuItem>
          <MenuItem
            className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
            onClick={() => void navigate({ to: "/settings" })}
          >
            <SidebarContextMenuIcon icon={SettingsIcon} />
            <span>Settings</span>
            <MenuShortcut>{settingsShortcutLabel()}</MenuShortcut>
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          {/* Sign-out also unlinks this machine's host (ADR 0015): its key
              leaves the directory and other devices' sessions to it end. */}
          <MenuItem variant="destructive" onClick={() => void handleSignOut()}>
            <span>Sign out</span>
          </MenuItem>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function SignedOutFooter() {
  const navigate = useNavigate();
  const openSignIn = useAccountDialogStore((state) => state.openSignIn);

  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={UserIcon}
        iconClassName="size-5"
        label="Sign in"
        tooltip="Sign in"
        tooltipSide="right"
        className={appRailButtonClassName(false)}
      />
      <ComposerPickerMenuPopup side="right" align="end" className="w-64 min-w-64">
        <MenuGroup>
          <div className="flex flex-col gap-0.5 px-2 py-1.5">
            <span className="text-ui font-medium text-foreground">You&rsquo;re in local mode</span>
            <span className="text-ui-sm leading-snug text-muted-foreground">
              Sign in to sync your profile and workspace across devices.
            </span>
          </div>
          <div className="px-2 pt-1 pb-1.5">
            <MenuItem
              className="w-full justify-center rounded-lg border border-transparent bg-primary text-primary-foreground data-highlighted:bg-primary/90 data-highlighted:text-primary-foreground"
              onClick={openSignIn}
            >
              Sign in
            </MenuItem>
          </div>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuItem
            className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
            onClick={() => void navigate({ to: "/settings" })}
          >
            <SidebarContextMenuIcon icon={SettingsIcon} />
            <span>Settings</span>
            <MenuShortcut>{settingsShortcutLabel()}</MenuShortcut>
          </MenuItem>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
