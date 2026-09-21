// renders the Central folder assets via CSS mask — avoids the stroke-on-stroke "stamped twice" artifact the previous inline SVG showed on the folder lip and keeps a single uniform fill at any opacity

import type { CSSProperties, SVGProps } from "react";
import { CentralIcon } from "~/lib/central-icons";

function FolderGlyph(name: string, props: SVGProps<SVGSVGElement>) {
  const ariaLabelRaw = (props as { ["aria-label"]?: unknown })["aria-label"];
  const label = typeof ariaLabelRaw === "string" ? ariaLabelRaw : undefined;
  return (
    <CentralIcon
      name={name}
      className={typeof props.className === "string" ? props.className : undefined}
      style={props.style as CSSProperties | undefined}
      label={label}
    />
  );
}

export function FolderClosed(props: SVGProps<SVGSVGElement>) {
  return FolderGlyph("folder-2", props);
}

export function FolderOpen(props: SVGProps<SVGSVGElement>) {
  return FolderGlyph("folder-open-front", props);
}
