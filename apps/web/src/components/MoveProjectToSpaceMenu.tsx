// FILE: MoveProjectToSpaceMenu.tsx
// Purpose: Shared Space destination menu for local and remote sidebar projects.

import { SpaceId } from "@synara/contracts";
import type { ReactNode } from "react";
import { useTranslation } from "~/i18n";
import {
  VOID_SPACE_KEY,
  spaceDisplayIcon,
  spaceKey,
  type VoidSpacePresentation,
} from "../lib/spaceGrouping";
import type { Space } from "../types";
import { ComposerPickerMenuSubPopup } from "./chat/ComposerPickerMenuPopup";
import {
  SIDEBAR_CONTEXT_MENU_ICON_CLASS_NAME,
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
} from "./sidebarContextMenuStyles";
import { SpaceIcon } from "./SpaceIcon";
import { MenuRadioGroup, MenuRadioItem, MenuSub, MenuSubTrigger } from "./ui/menu";

export function MoveProjectToSpaceMenu({
  spaceId,
  spaces,
  voidSpace,
  onMove,
  children,
}: {
  spaceId: SpaceId | null;
  spaces: readonly Space[];
  voidSpace: VoidSpacePresentation;
  onMove: (spaceId: SpaceId | null) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <MenuSub keepOpenOnFocusOut>
      <MenuSubTrigger className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}>
        <span className={SIDEBAR_CONTEXT_MENU_ICON_CLASS_NAME}>
          <SpaceIcon icon={spaceDisplayIcon(spaceId, spaces, voidSpace)} />
        </span>
        <span>{t("workspace:moveToSpace")}</span>
      </MenuSubTrigger>
      <ComposerPickerMenuSubPopup className="min-w-48">
        <MenuRadioGroup
          value={spaceKey(spaceId)}
          onValueChange={(value) =>
            onMove(value === VOID_SPACE_KEY ? null : SpaceId.makeUnsafe(value))
          }
        >
          <MenuRadioItem value={VOID_SPACE_KEY}>
            <SpaceIcon icon={voidSpace.icon} className="size-3.5" />
            <span className="min-w-0 truncate">{voidSpace.name}</span>
          </MenuRadioItem>
          {spaces.map((space) => (
            <MenuRadioItem key={space.id} value={space.id}>
              <SpaceIcon icon={space.icon} className="size-3.5" />
              <span className="min-w-0 truncate">{space.name}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {children}
      </ComposerPickerMenuSubPopup>
    </MenuSub>
  );
}
