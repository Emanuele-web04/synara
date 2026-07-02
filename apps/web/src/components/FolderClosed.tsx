// FILE: FolderClosed.tsx
// Purpose: Shared folder glyphs (closed/open) used by the sidebar, command
//          palette, picker, and composer.
// Layer: Web UI primitive
// Exports: FolderClosed, FolderOpen
// Notes: Renders Central "folder-2" / "folder-open-front" assets via CSS mask, which
//        both avoids the stroke-on-stroke "stamped twice" artifact the previous
//        inline SVG showed on the folder lip and keeps the icon as a single
//        uniform fill regardless of opacity. Consumers continue to pass
//        className/style/aria-label like before.

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
