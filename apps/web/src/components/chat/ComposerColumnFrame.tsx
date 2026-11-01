// FILE: ComposerColumnFrame.tsx
// Purpose: Shared composer column wrapper and the stacked rail that must live inside it
// (queued follow-ups). Keeps stacked panels aligned with the composer input instead of the
// full gutter viewport.
// Layer: Chat composer layout
// Exports: ComposerColumnFrame, ComposerStackedHeaderFrame

import {
  createContext,
  memo,
  useContext,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "~/lib/utils";
import {
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
  COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME,
} from "./composerPickerStyles";

const ComposerColumnFrameContext = createContext(false);

function useComposerColumnFrameContext(componentName: string) {
  const insideComposerColumnFrame = useContext(ComposerColumnFrameContext);
  if (import.meta.env.DEV && !insideComposerColumnFrame) {
    console.warn(
      `${componentName} must render inside ComposerColumnFrame so stacked activity stays aligned to the composer input width.`,
    );
  }
  return insideComposerColumnFrame;
}

interface ComposerColumnFrameProps {
  children: ReactNode;
  className?: string;
}

/** Centers the composer column at the shared chat max width. */
export const ComposerColumnFrame = function ComposerColumnFrame({
  children,
  className,
}: ComposerColumnFrameProps) {
  return (
    <ComposerColumnFrameContext.Provider value={true}>
      <div className={cn(COMPOSER_COLUMN_FRAME_CLASS_NAME, className)}>{children}</div>
    </ComposerColumnFrameContext.Provider>
  );
};

interface ComposerStackedHeaderFrameProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  ref?: Ref<HTMLDivElement> | undefined;
}

/** Full-width rail for panels stacked flush above the composer input. */
export const ComposerStackedHeaderFrame = memo(function ComposerStackedHeaderFrame({
  children,
  className,
  ref,
  ...rest
}: ComposerStackedHeaderFrameProps) {
  useComposerColumnFrameContext("ComposerStackedHeaderFrame");

  return (
    <div ref={ref} className={cn(COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME, className)} {...rest}>
      {children}
    </div>
  );
});
