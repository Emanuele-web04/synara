import { newMessageId } from "~/lib/utils";
import { type ChatMessage } from "../../types";

export function makeAutomationSetupBubble(role: "user" | "assistant", text: string): ChatMessage {
  return {
    id: newMessageId(),
    role,
    text,
    createdAt: new Date().toISOString(),
    streaming: false,
    source: "native",
  };
}
