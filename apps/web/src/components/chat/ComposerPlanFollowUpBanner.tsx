import { memo } from "react";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  return (
    <div className="px-5 pt-4 pb-4 sm:px-6 sm:pt-4.5 sm:pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">Plan ready</span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{planTitle}</span>
        ) : null}
      </div>
      {/* <div className="mt-2 text-xs text-muted-foreground">
        Review the plan
      </div> */}
    </div>
  );
});
