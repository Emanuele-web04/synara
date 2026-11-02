import { Button } from "./button";

/** The shared accept/dismiss controls for inert proposals. */
export function ProposalActions(props: {
  pending: boolean;
  onResolve: (resolution: "accepted" | "dismissed") => void;
  acceptLabel?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.pending}
        onClick={() => props.onResolve("dismissed")}
      >
        Dismiss
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={props.pending}
        onClick={() => props.onResolve("accepted")}
      >
        {props.acceptLabel ?? "Accept"}
      </Button>
    </div>
  );
}
