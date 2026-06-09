import { Skeleton } from "../ui/skeleton";
import { ReviewLoadingRows } from "./reviewPrimitives";

export function ReviewPrHeaderSkeleton() {
  return (
    <div className="flex shrink-0 flex-col gap-4 border-b border-border/50 bg-background px-4 py-5 sm:px-6">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-12" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded-full" />
            <Skeleton className="h-7 w-2/3 max-w-[44rem]" />
          </div>
        </div>
        <Skeleton className="h-7 w-28 rounded-md" />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3 ps-0 sm:ps-6">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="size-4 rounded-full" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-5 w-40 rounded-md" />
        <Skeleton className="h-5 w-48 rounded-md" />
      </div>
      <div className="flex min-h-14 items-center gap-4 rounded-[1.55rem] border border-border/45 bg-card/35 px-4 py-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="ms-auto h-4 w-32" />
      </div>
    </div>
  );
}

function CommentCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-[1.2rem] border border-border/38 bg-card/38 p-4">
      <div className="flex items-center gap-1.5">
        <Skeleton className="size-4 rounded-full" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

export function ReviewOverviewSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-[64rem] flex-col gap-4 px-5 py-4 2xl:max-w-[70rem]"
      aria-busy="true"
      aria-label="Loading pull request overview"
    >
      <section className="flex flex-col gap-4 rounded-[1.2rem] border border-border/38 bg-card/38 p-5">
        <Skeleton className="h-5 w-28" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </section>
      <Skeleton className="ms-1 h-3 w-44" />
      <section className="rounded-[1.2rem] border border-border/38 bg-card/38 p-4">
        <div className="flex items-start gap-3">
          <Skeleton className="size-6 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-56" />
            <Skeleton className="mt-2 h-20 w-full rounded-[1rem]" />
          </div>
        </div>
      </section>
      <CommentCardSkeleton />
      <CommentCardSkeleton />
    </div>
  );
}

export function ReviewPrSidebarSkeleton() {
  return (
    <aside
      className="hidden w-[20rem] shrink-0 flex-col border-l border-border/65 bg-background xl:flex 2xl:w-[21rem]"
      aria-busy="true"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/55 px-3.5 py-3">
        <Skeleton className="size-7 rounded-md" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <div className="flex min-h-0 flex-col gap-3.5 overflow-hidden px-3.5 py-3">
        {[0, 1, 2, 3].map((index) => (
          <section
            key={index}
            className="flex flex-col gap-2 rounded-xl border border-border/25 bg-muted/12 p-3"
          >
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </section>
        ))}
      </div>
    </aside>
  );
}

export function ReviewRowsSkeleton(props: { rows?: number }) {
  return <ReviewLoadingRows {...(props.rows !== undefined ? { rows: props.rows } : {})} />;
}
