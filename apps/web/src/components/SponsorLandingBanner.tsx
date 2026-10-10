// Purpose: Dismissible empty-landing promotion that opens Synara's sponsorship page.

import { Schema } from "effect";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { StarIcon, XIcon } from "~/lib/icons";
import { openExternalLink } from "~/lib/linkChips";
import { cn } from "~/lib/utils";

const DISMISSED_STORAGE_KEY = "synara:sponsor-landing-banner:dismissed:v1";

export function SponsorLandingBanner(props: { className?: string }) {
  const [dismissed, setDismissed] = useLocalStorage(DISMISSED_STORAGE_KEY, false, Schema.Boolean);
  if (dismissed) return null;
  return (
    <div className={cn("group/landing-banner relative", props.className)}>
      <button
        type="button"
        data-testid={"sponsor-landing-banner"}
        className="flex w-full cursor-pointer items-center gap-4 rounded-2xl px-4 py-3 text-left transition-colors duration-150 ease-out hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
        onClick={() => openExternalLink("https://www.trysynara.com/sponsor")}
      >
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center text-primary"
        >
          <StarIcon className="size-5" />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-ui font-medium text-foreground">Support Synara</span>
          <span className="truncate text-ui text-muted-foreground">
            Explore sponsorships and help fund development
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss sponsor banner"
        className="absolute -right-1.5 -top-1.5 flex size-[22px] items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground opacity-0 shadow-xs transition-opacity duration-150 ease-out hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 group-hover/landing-banner:opacity-100 motion-reduce:transition-none"
        onClick={() => setDismissed(true)}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
