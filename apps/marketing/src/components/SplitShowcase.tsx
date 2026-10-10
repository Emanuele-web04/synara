import type { ReactNode } from "react";

type SplitShowcaseProps = {
  title: string;
  description: string;
  reverse?: boolean;
  stacked?: boolean;
  // keep the screenshot large on mobile for detailed full-app shots that go illegible when shrunk; default cards shrink it so the backdrop reads around it
  prominentMedia?: boolean;
  kicker?: string;
  children: ReactNode;
};

export function SplitShowcase({
  title,
  description,
  reverse,
  stacked,
  prominentMedia,
  kicker,
  children,
}: SplitShowcaseProps) {
  const wrapperClass = stacked
    ? "flex flex-col gap-6 py-8 sm:gap-8 sm:py-12"
    : "grid grid-cols-1 gap-6 py-16 sm:gap-10 sm:py-24 lg:grid-cols-2 lg:items-center lg:gap-12 xl:gap-16";

  const textColClass = stacked ? "min-w-0" : `min-w-0 ${reverse ? "lg:order-2" : "lg:order-1"}`;

  const mockOrderClass = stacked ? "" : reverse ? "lg:order-1" : "lg:order-2";

  return (
    <div className={wrapperClass}>
      <div className={textColClass}>
        {kicker && (
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--accent-link)]">
            {kicker}
          </p>
        )}
        <h3 className="text-[1.35rem] font-medium leading-[1.15] tracking-[-0.035em] text-[var(--text-primary)] sm:text-[1.5rem]">
          {title}
        </h3>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.7] text-[var(--text-secondary)] sm:text-[16px]">
          {description}
        </p>
      </div>
      <div className={`relative flex min-h-0 min-w-0 flex-col ${mockOrderClass}`}>
        <div className="relative isolate flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-2xl p-3 sm:p-4">
          <div aria-hidden className="shot-card-bg absolute inset-0 -z-10" />
          {/* screenshot stays at 60% so the painting backdrop reads around it; prominentMedia rows fill the card on mobile and ease back as the viewport widens to stay legible */}
          <div className={prominentMedia ? "w-full sm:w-3/4 lg:w-3/5" : "w-3/5"}>{children}</div>
        </div>
      </div>
    </div>
  );
}
