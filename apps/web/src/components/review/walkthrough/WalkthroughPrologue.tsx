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
import { cn } from "~/lib/utils";
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
  const hasPrecedingSection =
    Boolean(prologue.motivation || prologue.outcome) ||
    prologue.keyChanges.length > 0 ||
    prologue.focusAreas.length > 0;
  return (
    <article className="mx-auto w-full max-w-3xl px-5 py-7 sm:px-7">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <SparklesIcon className="size-3.5" />
        Overview
      </div>
      <h2
        tabIndex={-1}
        data-walkthrough-heading
        className="mt-2 text-balance break-words [overflow-wrap:anywhere] rounded-sm text-[26px] font-semibold leading-8 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {props.title}
      </h2>
      {props.body ? (
        <p className="mt-3 max-w-2xl text-[14px] leading-6 text-muted-foreground">{props.body}</p>
      ) : null}

      {prologue.motivation || prologue.outcome ? (
        <div
          className={cn(
            "mt-6 grid gap-3",
            prologue.motivation && prologue.outcome && "sm:grid-cols-2",
          )}
        >
          {prologue.motivation ? (
            <ProseCard icon={<InfoIcon className="size-3.5" />} label="Motivation" tone="info">
              {prologue.motivation}
            </ProseCard>
          ) : null}
          {prologue.outcome ? (
            <ProseCard
              icon={<CircleCheckIcon className="size-3.5" />}
              label="Outcome"
              tone="success"
            >
              {prologue.outcome}
            </ProseCard>
          ) : null}
        </div>
      ) : null}

      {prologue.keyChanges.length > 0 ? (
        <section className="mt-10">
          <SectionHeading icon={<ListChecksIcon className="size-4" />} title="Key changes" />
          <ul className="mt-3 space-y-3">
            {prologue.keyChanges.map((change) => (
              <li key={change.summary} className="flex min-w-0 items-start gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/45"
                />
                <span className="min-w-0">
                  <span className="break-words [overflow-wrap:anywhere] text-[14px] font-medium text-foreground">
                    {change.summary}
                  </span>
                  <span className="mt-0.5 block break-words [overflow-wrap:anywhere] text-[12px] leading-5 text-muted-foreground">
                    {change.description}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {prologue.focusAreas.length > 0 ? (
        <section className="mt-10">
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

      <div className={hasPrecedingSection ? "mt-10" : "mt-6"}>
        <ComplexityMeter
          level={prologue.complexity.level}
          reasoning={prologue.complexity.reasoning}
        />
      </div>

      {props.canStart ? (
        <div className="mt-10 flex justify-end border-t border-border/40 pt-5">
          <Button
            size="sm"
            variant="prominent"
            className="group px-3.5 text-[12px] transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
            onClick={props.onStart}
          >
            Start reading
            <ChevronRightIcon className="size-3.5 transition-transform duration-150 ease-out group-hover:translate-x-0.5 motion-reduce:transition-none" />
          </Button>
        </div>
      ) : null}
    </article>
  );
}
