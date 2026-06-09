// Purpose: Presentational pieces for the sidebar search palette (icons, theme
// badge, highlighted text). Kept beside the palette so the container file stays
// focused on state and layout.
import { DeviceLaptopIcon, MoonIcon, SunIcon } from "~/lib/icons";
import { type ProviderKind } from "@t3tools/contracts";
import { BsChat } from "react-icons/bs";
import { LuArrowDownToLine } from "react-icons/lu";
import { type ComponentType, useMemo } from "react";
import { NewThreadIcon, SettingsIcon } from "~/lib/icons";
import { FolderClosed } from "./FolderClosed";
import { ProviderIcon as SharedProviderIcon } from "./ProviderIcon";
import { escapeRegExp, tokenizeHighlightQuery } from "./SidebarSearchPalette.logic";

export type IconComponent = ComponentType<{ className?: string }>;

export const ACTION_ICONS: Record<string, IconComponent> = {
  "new-chat": BsChat,
  "new-thread": NewThreadIcon,
  "add-project": FolderClosed,
  "import-thread": LuArrowDownToLine,
  settings: SettingsIcon,
};

export const THEME_MODE_ICONS: Record<"system" | "light" | "dark", IconComponent> = {
  system: DeviceLaptopIcon,
  light: SunIcon,
  dark: MoonIcon,
};

export function PaletteIcon(props: { icon: IconComponent }) {
  const Icon = props.icon;
  return (
    <div className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      <Icon className="size-[15px]" />
    </div>
  );
}

export function CodeThemeBadge(props: { accent: string; background: string; foreground: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border font-medium text-[10px] leading-none tracking-[-0.01em]"
      style={{
        backgroundColor: props.background,
        borderColor: `${props.foreground}26`,
        color: props.accent,
      }}
    >
      Aa
    </span>
  );
}

export function ProviderIcon(props: { provider: ProviderKind }) {
  return (
    <div className="flex size-5 shrink-0 items-center justify-center">
      <SharedProviderIcon provider={props.provider} className="size-[15px]" />
    </div>
  );
}

export function HighlightedText(props: { text: string; query: string; className?: string }) {
  const segments = useMemo(() => {
    const tokens = tokenizeHighlightQuery(props.query);
    if (tokens.length === 0) {
      return [{ key: "full", text: props.text, highlighted: false }];
    }

    const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
    const parts = props.text.split(pattern).filter((part) => part.length > 0);
    let offset = 0;
    return parts.map((part) => {
      const segment = {
        key: `${offset}-${part.length}`,
        text: part,
        highlighted: tokens.some((token) => token === part.toLowerCase()),
      };
      offset += part.length;
      return segment;
    });
  }, [props.query, props.text]);

  return (
    <span className={props.className}>
      {segments.map((segment) =>
        segment.highlighted ? (
          <mark
            key={segment.key}
            className="rounded-[3px] bg-amber-200/80 px-[1px] text-current dark:bg-amber-300/25"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={segment.key}>{segment.text}</span>
        ),
      )}
    </span>
  );
}
