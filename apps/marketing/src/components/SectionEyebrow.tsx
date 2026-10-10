// `as` exists because the same treatment is a page eyebrow <p> in one spot and a real <h2> in another — shared styling, different document outline

import { cn } from "@/lib/utils";

export function SectionEyebrow({
  children,
  as: Tag = "h2",
  className,
}: {
  children: React.ReactNode;
  as?: "h2" | "h3" | "p";
  className?: string;
}) {
  return (
    <Tag
      className={cn(
        "font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-tertiary)]",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
