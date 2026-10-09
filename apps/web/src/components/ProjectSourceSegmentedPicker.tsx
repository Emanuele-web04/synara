import { GitHubIcon, FolderIcon } from "~/lib/icons";

import { SegmentedPicker } from "./SegmentedPicker";

export type ProjectSource = "local" | "github";

/**
 * The compact raised-thumb picker previously used for the Synara/Groups switch,
 * adapted to choose how a project is added.
 */
export function ProjectSourceSegmentedPicker(props: {
  readonly value: ProjectSource;
  readonly disabled: boolean;
  readonly githubAvailable: boolean;
  readonly githubUnavailableReason?: string;
  readonly onValueChange: (value: ProjectSource) => void;
  readonly className?: string;
}) {
  return (
    <SegmentedPicker
      ariaLabel="Project source"
      value={props.value}
      disabled={props.disabled}
      onValueChange={props.onValueChange}
      {...(props.className ? { className: props.className } : {})}
      options={[
        {
          value: "local",
          label: "Folder",
          icon: <FolderIcon className="size-3.5" aria-hidden="true" />,
        },
        {
          value: "github",
          label: "GitHub",
          icon: <GitHubIcon className="size-3.5" aria-hidden="true" />,
          disabled: !props.githubAvailable,
          ...(props.githubAvailable
            ? {}
            : {
                title:
                  props.githubUnavailableReason ??
                  "Update the Synara server to add GitHub projects.",
              }),
        },
      ]}
    />
  );
}
