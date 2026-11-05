// FILE: ChatText.tsx
// Purpose: A message's text in a SynBot bubble (HoloBot's thread/ChatText.tsx). It renders with
//          Synara's ChatMarkdown, so links, thread:// links, file paths, code blocks, math and the
//          streamed-text cadence behave as in every Synara chat; thread.css sets it in HoloBot's
//          ChatText look (the bubble's size and color, tight paragraphs, soft code and links).
// Layer: SynBot thread UI
// Exports: ChatText

import type { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import ChatMarkdown from "../../ChatMarkdown";

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
  const navigate = useNavigate();
  const openThread = useCallback(
    (target: ThreadId) => void navigate({ to: "/$threadId", params: { threadId: target } }),
    [navigate],
  );
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
