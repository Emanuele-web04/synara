import type { ReactNode } from "react";

import {
  DISCLOSURE_INNER_CLASS,
  disclosureContentClassName,
  disclosureShellClassName,
} from "~/lib/disclosureMotion";

export function DisclosureRegion(props: {
  open: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const { open, children, className, contentClassName } = props;

  return (
    <div
      className={disclosureShellClassName(open, className)}
      aria-hidden={open ? undefined : true}
      inert={!open}
    >
      <div className={DISCLOSURE_INNER_CLASS}>
        <div className={disclosureContentClassName(open, contentClassName)}>{children}</div>
      </div>
    </div>
  );
}
