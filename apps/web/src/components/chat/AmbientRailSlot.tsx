// FILE: AmbientRailSlot.tsx
// Purpose: Positions rail content below the Environment card with a smooth
// slide when the card opens or closes.
// Layer: Chat surface UI
// Depends on: React only.
//
// The env card closes by sliding away while keeping its flex height, which
// would strand anything below it under a phantom gap. This slot measures the
// previous sibling (the env card) and pulls up by exactly its height while
// the env is closed, on the same 220ms clock — content glides into the
// vacated place. Must stay position: static: the preview card measures its
// offset parent for vertical space, and that must remain the full-height rail
// wrapper rather than this slot.

import { useEffect, useRef, useState, type ReactNode } from "react";

export function AmbientRailSlot(props: {
  readonly envOpen: boolean;
  readonly children: ReactNode;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [envHeight, setEnvHeight] = useState(0);
  useEffect(() => {
    const sibling = slotRef.current?.previousElementSibling as HTMLElement | null;
    if (!sibling) return;
    const update = () => {
      const height = sibling.offsetHeight;
      setEnvHeight((previous) => (previous === height ? previous : height));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(sibling);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={slotRef}
      className="transition-[margin] duration-220 ease-out motion-reduce:transition-none"
      style={{ marginTop: props.envOpen ? 0 : -envHeight }}
    >
      {props.children}
    </div>
  );
}
