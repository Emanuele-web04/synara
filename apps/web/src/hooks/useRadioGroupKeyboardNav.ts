import { type KeyboardEvent, type Ref, useRef } from "react";

const ARROW_KEY_DELTAS: Record<string, 1 | -1> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

export type RadioGroupItemProps = {
  ref: Ref<HTMLButtonElement>;
  tabIndex: number;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

// roving tabindex for custom radio groups: only the selected option is in the tab order, arrows move selection+focus wrapping at the ends
export function useRadioGroupKeyboardNav<T extends string>({
  values,
  value,
  onValueChange,
}: {
  values: readonly T[];
  value: T;
  onValueChange: (value: T) => void;
}): (itemValue: T) => RadioGroupItemProps {
  const itemNodesRef = useRef(new Map<T, HTMLButtonElement>());

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, itemValue: T) => {
    const delta = ARROW_KEY_DELTAS[event.key];
    if (!delta || values.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, values.indexOf(itemValue));
    const nextValue = values[(currentIndex + delta + values.length) % values.length];
    if (nextValue === undefined || nextValue === itemValue) return;
    onValueChange(nextValue);
    itemNodesRef.current.get(nextValue)?.focus();
  };

  return (itemValue: T): RadioGroupItemProps => ({
    ref: (node: HTMLButtonElement | null) => {
      if (node) {
        itemNodesRef.current.set(itemValue, node);
      } else {
        itemNodesRef.current.delete(itemValue);
      }
    },
    tabIndex: itemValue === value ? 0 : -1,
    onKeyDown: (event) => handleKeyDown(event, itemValue),
  });
}
