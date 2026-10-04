import { CheckIcon, LoaderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

type TaskProgressStep = {
  id: string;
  text: string;
  status: "pending" | "inProgress" | "completed";
};

export function TaskProgressSteps({
  steps,
  className,
  textClassName,
}: {
  steps: readonly TaskProgressStep[];
  className?: string;
  textClassName?: string;
}) {
  return (
    <ol className={cn("space-y-0", className)}>
      {steps.map((step, index) => (
        <li
          key={step.id}
          className="flex items-start gap-2 py-1"
          aria-label={`${step.text}: ${step.status}`}
        >
          <div
            className={cn(
              "mt-[3px] flex shrink-0 items-center gap-1.5 text-ui",
              step.status === "completed"
                ? "text-muted-foreground/45"
                : step.status === "inProgress"
                  ? "text-foreground/80"
                  : "text-muted-foreground/60",
            )}
          >
            <span className="flex size-3.5 items-center justify-center" aria-hidden>
              {step.status === "completed" ? (
                <CheckIcon className="size-3" />
              ) : step.status === "inProgress" ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <span className="block size-[7px] rounded-full border border-current" />
              )}
            </span>
            <span className="tabular-nums" aria-hidden>
              {index + 1}.
            </span>
          </div>
          <p
            className={cn(
              "min-w-0 flex-1 text-ui leading-5 text-foreground/85",
              textClassName,
              step.status === "completed" && "text-muted-foreground/50 line-through",
            )}
          >
            {step.text}
          </p>
        </li>
      ))}
    </ol>
  );
}
