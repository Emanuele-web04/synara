// FILE: ChatText.tsx
// Purpose: A message's text in a SynBot bubble (HoloBot's thread/ChatText.tsx). It renders with
//          Synara's ChatMarkdown, so links, thread:// links, file paths, code blocks, math and the
//          streamed-text cadence behave as in every Synara chat; thread.css sets it in HoloBot's
//          ChatText look (the bubble's size and color, tight paragraphs, soft code and links).
//          A thread link stays on the SynBot page: a bot's thread opens that bot, a worker's
//          thread the task pane.
// Layer: SynBot thread UI
// Exports: ChatText

import type { ThreadId } from "@synara/contracts";

import ChatMarkdown from "../../ChatMarkdown";
import { useOpenThreadLink } from "./chatLinks";

export function ChatText({
  text,
  tone = "bot",
  threadId,
  streaming = false,
}: {
  readonly text: string;
  /** Whose words: the user's keep exactly what was typed. */
  readonly tone?: "bot" | "user";
  readonly threadId?: ThreadId | null;
  readonly streaming?: boolean;
}) {
  const openThread = useOpenThreadLink();
  return (
    <ChatMarkdown
      text={text}
      cwd={undefined}
      threadId={threadId ?? null}
      variant={tone === "user" ? "user" : "assistant"}
      isStreaming={streaming}
      className=""
      onOpenThread={openThread}
    />
  );
}
