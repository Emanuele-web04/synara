const CANVAS_CONTEXT_VERSION = 1;

export function wrapCanvasAgentContext(input: {
  readonly threadId: string;
  readonly messageText: string;
}): string {
  return `<canvas_context version="${CANVAS_CONTEXT_VERSION}" drawing_id="${input.threadId}">
You are collaborating on the current editable Excalidraw Drawing. Call read_me before your first drawing operation in this conversation, then call read_scene before modifying an existing scene. If a choice changes factual structure, ask exactly one focused clarification question before drawing; choose sensible defaults for visual-only choices. Use create_view for scene changes, preserve unrelated elements and stable ids, and summarize the completed change briefly. Do not access or select another Drawing.
</canvas_context>

<latest_user_message>
${input.messageText}
</latest_user_message>`;
}
