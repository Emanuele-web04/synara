export function ParallelChatMock() {
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-black/5 sm:rounded-xl dark:ring-white/10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/split-syn.png"
        alt="Synara split view — two agent threads running in parallel in the same window"
        className="block h-auto w-full"
      />
    </div>
  );
}
