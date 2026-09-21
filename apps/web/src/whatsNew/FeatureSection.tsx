import { cn } from "~/lib/utils";

import type { WhatsNewFeature } from "./logic";

export interface FeatureSectionProps {
  readonly feature: WhatsNewFeature;
  readonly className?: string;
}

// IndieDevs feature-card layout: title+description always visible, image framed uncropped below, details as a compact footnote blurb
export function FeatureSection({ feature, className }: FeatureSectionProps) {
  const hasMedia = feature.image !== undefined || feature.details !== undefined;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-base font-semibold leading-snug text-foreground">
          {feature.title}
        </h3>
        <p className="text-ui leading-relaxed text-muted-foreground">{feature.description}</p>
      </div>
      {hasMedia && (
        <div className="flex flex-col gap-1.5">
          {feature.image !== undefined && (
            <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/40">
              <img
                src={feature.image}
                alt={feature.imageAlt ?? ""}
                className="h-auto w-full"
                loading="lazy"
                decoding="async"
              />
            </div>
          )}
          {feature.details !== undefined && (
            <p className="text-ui leading-relaxed text-muted-foreground/85">{feature.details}</p>
          )}
        </div>
      )}
    </div>
  );
}
