// FILE: TaskDelegateChatPicker.tsx
// Purpose: The delegate form's "Chat" control: start a new chat or hand the to-do to a
//          recent one.
// Layer: Tasks UI component
// Exports: TaskDelegateChatPicker

import type { ThreadId } from "@synara/contracts";

import { ProviderIcon } from "~/components/ProviderIcon";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "~/components/ui/menu";
import { ChevronDownIcon } from "~/lib/icons";
import type { TaskDelegateChatState } from "./useTaskDelegateChat";

export function TaskDelegateChatPicker({ chat }: { chat: TaskDelegateChatState }) {
  const { existingChat, existingChatId, setExistingChatId, recentChats, projectNameById } = chat;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="chrome"
            className="w-fit max-w-full justify-start gap-1.5 text-ui-sm"
          />
        }
      >
        {existingChat ? (
          <>
            <ProviderIcon
              provider={existingChat.modelSelection.provider}
              className="size-3.5 shrink-0"
            />
            <span className="min-w-0 truncate">{existingChat.title}</span>
          </>
        ) : (
          <span>New chat</span>
        )}
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" className="max-w-80 min-w-64">
        <MenuRadioGroup
          value={existingChatId ?? ""}
          onValueChange={(value) => setExistingChatId(value ? (value as ThreadId) : null)}
        >
          <MenuRadioItem value="" closeOnClick>
            New chat
          </MenuRadioItem>
          {recentChats.length > 0 ? (
            <MenuGroup>
              <MenuGroupLabel>Recent chats</MenuGroupLabel>
              {recentChats.map((thread) => (
                <MenuRadioItem key={thread.id} value={thread.id} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <ProviderIcon
                      provider={thread.modelSelection.provider}
                      className="size-3.5 shrink-0"
                    />
                    <span className="min-w-0 truncate">{thread.title}</span>
                    <span className="shrink-0 text-ui-xs text-muted-foreground">
                      {projectNameById.get(thread.projectId) ?? ""}
                    </span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuGroup>
          ) : null}
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
