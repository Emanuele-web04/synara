import type { ReviewWalkthroughPrologue } from "@t3tools/contracts";
import type { ReactElement } from "react";

import {
  ChevronRightIcon,
  CircleCheckIcon,
  InfoIcon,
  ListChecksIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "~/lib/icons";
import { Button } from "../../ui/button";
import { ComplexityMeter, FocusAreaCard, ProseCard, SectionHeading } from "./walkthroughPrimitives";

export function WalkthroughPrologue(props: {
  prologue: ReviewWalkthroughPrologue;
  title: string;
  body: string | null;
  canStart: boolean;
  onStart: () => void;
}): ReactElement {
  const { prologue } = props;
  return (
    <article className="mx-auto w-full max-w-3xl px-5 py-7 sm:px-7">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <SparklesIcon className="size-3.5" />
        Overview
      </div>
      <h1 className="mt-2 text-balance text-[26px] font-semibold leading-8 text-foreground">
        {props.title}
      </h1>
      {props.body ? (
        <p className="mt-3 max-w-2xl text-[14px] leading-6 text-muted-foreground">{props.body}</p>
      ) : null}

      {prologue.motivation || prologue.outcome ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {prologue.motivation ? (
            <ProseCard icon={<InfoIcon className="size-3.5" />} label="Why this change" tone="info">
              {prologue.motivation}
            </ProseCard>
          ) : null}
          {prologue.outcome ? (
            <ProseCard
              icon={<CircleCheckIcon className="size-3.5" />}
              label="What's better now"
              tone="success"
            >
              {prologue.outcome}
            </ProseCard>
          ) : null}
        </div>
      ) : null}

      <ComplexityMeter
        level={prologue.complexity.level}
        reasoning={prologue.complexity.reasoning}
      />

      {prologue.keyChanges.length > 0 ? (
        <section className="mt-8">
          <SectionHeading icon={<ListChecksIcon className="size-4" />} title="Key changes" />
          <ul className="mt-3 space-y-2.5">
            {prologue.keyChanges.map((change) => (
              <li key={change.summary} className="flex min-w-0 items-start gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/45"
                />
                <span className="min-w-0">
                  <span className="text-[13px] font-medium text-foreground">{change.summary}</span>
                  <span className="mt-0.5 block text-[12px] leading-5 text-muted-foreground">
                    {change.description}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {prologue.focusAreas.length > 0 ? (
        <section className="mt-8">
          <SectionHeading
            icon={<TriangleAlertIcon className="size-4" />}
            title="Where to look closely"
          />
          <div className="mt-3 space-y-2.5">
            {prologue.focusAreas.map((area) => (
              <FocusAreaCard key={area.title} area={area} />
            ))}
          </div>
        </section>
      ) : null}

      {props.canStart ? (
        <div className="mt-9 flex justify-end border-t border-border/35 pt-5">
          <Button
            size="sm"
            variant="prominent"
            className="px-3.5 text-[12px]"
            onClick={props.onStart}
          >
            Start reading
            <ChevronRightIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </article>
  );
}
