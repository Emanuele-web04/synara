import type { ReviewChangesetResult, ReviewSourceRef } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { reviewLoadChangesetQueryOptions } from "~/lib/reviewReactQuery";
import { rpcErrorMessage } from "~/lib/rpcErrorMessage";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { ReviewLayout } from "./ReviewLayout";

export function ReviewSurface(props: {
  mode: "page" | "dock";
  cwd: string | null;
  source: ReviewSourceRef | null;
  selectedFilePath?: string | null;
  onSelectedFilePathChange?: (path: string | null) => void;
  reviewAction?: ReactNode;
  navigationAction?: ReactNode;
  changesetState?: {
    data: ReviewChangesetResult | undefined;
    isLoading: boolean;
    error: unknown;
  };
}) {
  const changesetQuery = useQuery({
    ...reviewLoadChangesetQueryOptions({ cwd: props.cwd, source: props.source }),
    enabled: props.changesetState === undefined && props.cwd !== null && props.source !== null,
  });
  const changesetState = props.changesetState ?? changesetQuery;

  const error = changesetState.error
    ? (rpcErrorMessage(changesetState.error) ?? "Failed to load changeset.")
    : null;

  const reference = props.source?._tag === "pullRequest" ? props.source.reference : null;

  return (
    <DiffWorkerPoolProvider>
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <ReviewLayout
          mode={props.mode}
          files={changesetState.data?.files ?? []}
          patch={changesetState.data?.patch}
          target={changesetState.data?.target ?? null}
          isLoading={changesetState.isLoading && props.source !== null}
          error={error}
          cwd={props.cwd}
          source={props.source}
          reference={reference}
          expectedHeadSha={changesetState.data?.headSha ?? null}
          patchSignature={changesetState.data?.patchSignature ?? null}
          selectedFilePath={props.selectedFilePath ?? null}
          reviewAction={props.reviewAction}
          navigationAction={props.navigationAction}
          {...(props.onSelectedFilePathChange
            ? { onSelectedFilePathChange: props.onSelectedFilePathChange }
            : {})}
        />
      </div>
    </DiffWorkerPoolProvider>
  );
}
