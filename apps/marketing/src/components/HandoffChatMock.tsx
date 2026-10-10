export function HandoffChatMock() {
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-black/5 sm:rounded-xl dark:ring-white/10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/handoff-syn.png"
        alt="Synara hand-off menu — pass a thread to Claude, Cursor, Grok, OpenCode, or Pi mid-conversation"
        className="block h-auto w-full"
      />
    </div>
  );
}
