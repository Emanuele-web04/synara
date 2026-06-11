import type { ChatMessage } from "../../types";

export interface DeriveTimelineMessagesInput {
  readonly serverMessages: ChatMessage[];
  readonly isSidechat: boolean;
  readonly attachmentPreviewHandoffByMessageId: Readonly<Record<string, readonly string[]>>;
  readonly optimisticUserMessages: ChatMessage[];
}

function filterTimelineMessages(messages: ChatMessage[], isSidechat: boolean): ChatMessage[] {
  if (!isSidechat) {
    return messages;
  }
  const hasImportedForkMessage = messages.some((message) => message.source === "fork-import");
  return hasImportedForkMessage
    ? messages.filter((message) => message.source !== "fork-import")
    : messages;
}

function hasAttachmentPreviewHandoffs(
  attachmentPreviewHandoffByMessageId: Readonly<Record<string, readonly string[]>>,
): boolean {
  for (const messageId in attachmentPreviewHandoffByMessageId) {
    if (Object.hasOwn(attachmentPreviewHandoffByMessageId, messageId)) {
      return true;
    }
  }
  return false;
}

function applyImagePreviewHandoff(
  message: ChatMessage,
  handoffPreviewUrls: readonly string[],
): ChatMessage {
  if (!message.attachments || message.attachments.length === 0) {
    return message;
  }

  let imageIndex = 0;
  let attachments: ChatMessage["attachments"] | null = null;
  for (let index = 0; index < message.attachments.length; index += 1) {
    const attachment = message.attachments[index];
    if (!attachment) {
      continue;
    }
    if (attachment.type !== "image") {
      attachments?.push(attachment);
      continue;
    }

    const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
    imageIndex += 1;
    if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
      attachments?.push(attachment);
      continue;
    }

    if (!attachments) {
      attachments = message.attachments.slice(0, index);
    }
    attachments.push({
      ...attachment,
      previewUrl: handoffPreviewUrl,
    });
  }

  return attachments ? { ...message, attachments } : message;
}

function applyAttachmentPreviewHandoff(
  messages: ChatMessage[],
  attachmentPreviewHandoffByMessageId: Readonly<Record<string, readonly string[]>>,
): ChatMessage[] {
  if (!hasAttachmentPreviewHandoffs(attachmentPreviewHandoffByMessageId)) {
    return messages;
  }

  let nextMessages: ChatMessage[] | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role !== "user") {
      nextMessages?.push(message);
      continue;
    }
    const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
    if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
      nextMessages?.push(message);
      continue;
    }

    const nextMessage = applyImagePreviewHandoff(message, handoffPreviewUrls);
    if (nextMessage !== message && !nextMessages) {
      nextMessages = messages.slice(0, index);
    }
    nextMessages?.push(nextMessage);
  }

  return nextMessages ?? messages;
}

function hasServerMessageId(messages: readonly ChatMessage[], messageId: ChatMessage["id"]) {
  return messages.some((message) => message.id === messageId);
}

export function deriveTimelineMessages(input: DeriveTimelineMessagesInput): ChatMessage[] {
  const filteredMessages = filterTimelineMessages(input.serverMessages, input.isSidechat);
  const serverMessagesWithPreviewHandoff = applyAttachmentPreviewHandoff(
    filteredMessages,
    input.attachmentPreviewHandoffByMessageId,
  );

  if (input.optimisticUserMessages.length === 0) {
    return serverMessagesWithPreviewHandoff;
  }
  if (input.optimisticUserMessages.length === 1) {
    const optimisticMessage = input.optimisticUserMessages[0];
    if (
      !optimisticMessage ||
      hasServerMessageId(serverMessagesWithPreviewHandoff, optimisticMessage.id)
    ) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, optimisticMessage];
  }
  const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
  const pendingMessages = input.optimisticUserMessages.filter(
    (message) => !serverIds.has(message.id),
  );
  if (pendingMessages.length === 0) {
    return serverMessagesWithPreviewHandoff;
  }
  return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
}
